import { formatWithOptions } from "util";
import test, { ExecutionContext } from "ava";
import { Redis as Client, Cluster } from "iovalkey";
import Redlock, { ExecutionError, ResourceLockedError } from "./index.js";

async function wait(ms: number): Promise<number> {
  return new Promise((resolve) => setTimeout(() => resolve(ms), ms));
}

async function fail(
  t: ExecutionContext<unknown>,
  error: unknown
): Promise<void> {

  if (!(error instanceof ExecutionError)) {
    throw error;
  }

  t.fail(`${error.message}
---
${(await Promise.all(error.attempts))
      .map(
        (s, i) =>
          `ATTEMPT ${i}: ${formatWithOptions(
            { colors: true },
            {
              membershipSize: s.membershipSize,
              quorumSize: s.quorumSize,
              votesForSize: s.votesFor.size,
              votesAgainstSize: s.votesAgainst.size,
              votesAgainstError: s.votesAgainst.values(),
            }
          )}`
      )
      .join("\n\n")}
`);
}

async function waitForCluster(redis: Cluster): Promise<void> {
  async function checkIsReady(): Promise<boolean> {
    return (
      ((await redis.cluster("INFO")) as string).match(
        /^cluster_state:(.+)$/m
      )?.[1] === "ok"
    );
  }

  let isReady = await checkIsReady();
  while (!isReady) {
    console.log("Waiting for cluster to be ready...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isReady = await checkIsReady();
  }

  async function checkIsWritable(): Promise<boolean> {
    try {
      return ((await redis.set("isWritable", "true")) as string) === "OK";
    } catch (error) {
      console.error(`Cluster unable to receive writes: ${error}`);
      return false;
    }
  }

  let isWritable = await checkIsWritable();
  while (!isWritable) {
    console.log("Waiting for cluster to be writable...");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isWritable = await checkIsWritable();
  }
}

function run(
  namespace: string,
  redisA: Client | Cluster,
  redisB: Client | Cluster,
  redisC: Client | Cluster
): void {

  test(`${namespace} - acquires, extends, and releases a single lock`, async (t) => {
    try {
      const redlock = new Redlock([redisA, redisB, redisC]);

      const duration = 1000 * 10;

      // Acquire a lock.
      let lock = await redlock.acquire(["{redlock}mfaersl"], duration);

      t.is(
        await redisA.get("{redlock}mfaersl"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}mfaersl"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}mfaersl"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redisA.pttl("{redlock}mfaersl")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redisB.pttl("{redlock}mfaersl")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redisC.pttl("{redlock}mfaersl")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Extend the lock.
      lock = await lock.extend(duration);
      t.is(
        await redisA.get("{redlock}mfaersl"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}mfaersl"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}mfaersl"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redisA.pttl("{redlock}mfaersl")) / 200),
        Math.round((duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redisB.pttl("{redlock}mfaersl")) / 200),
        Math.round((duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redisC.pttl("{redlock}mfaersl")) / 200),
        Math.round((duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redisA.get("{redlock}mfaersl"), null);
      t.is(await redisB.get("{redlock}mfaersl"), null);
      t.is(await redisC.get("{redlock}mfaersl"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - releasing expired lock doesn't fail`, async (t) => {
    try {
      const redlock = new Redlock([redisA, redisB, redisC]);

      const duration = 1000;

      // Acquire a lock.
      const lock = await redlock.acquire(["{redlock}a1"], duration);

      // Wait for duration + drift to be sure that lock has expired
      await wait(duration + redlock.calculateDrift(duration));

      // Release the lock.
      await lock.release();
      t.is(await redisA.get("{redlock}a1"), null, "The lock was not released");
      t.is(await redisB.get("{redlock}a1"), null, "The lock was not released");
      t.is(await redisC.get("{redlock}a1"), null, "The lock was not released");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - succeeds when a minority of clients fail`, async (t) => {
    try {
      const redlock = new Redlock([redisA, redisB, redisC]);

      const duration = 1000 * 6;

      // Set a value on redisC so that lock acquisition fails.
      await redisC.set("{redlock}b1", "other");

      // Acquire a lock.
      let lock = await redlock.acquire(["{redlock}b1"], duration);
      t.is(
        await redisA.get("{redlock}b1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}b1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}b1"),
        "other",
        "The lock value was changed."
      );
      t.is(
        Math.round((await redisA.pttl("{redlock}b1")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redisB.pttl("{redlock}b1")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        await redisC.pttl("{redlock}b1"),
        -1,
        "The lock expiration was changed"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redisA.get("{redlock}b1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisB.get("{redlock}b1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redisC.get("{redlock}b1"),
        "other",
        "The lock value was changed."
      );
      t.is(
        Math.round((await redisA.pttl("{redlock}b1")) / 200),
        Math.round((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redisB.pttl("{redlock}b1")) / 200),
        Math.round((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        await redisC.pttl("{redlock}b1"),
        -1,
        "The lock expiration was changed"
      );

      // Release the lock.
      await lock.release();
      t.is(await redisA.get("{redlock}b1"), null);
      t.is(await redisB.get("{redlock}b1"), null);
      t.is(await redisC.get("{redlock}b1"), "other");
      await redisC.del("{redlock}b");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - fails when a majority of clients fail`, async (t) => {
    try {
      const redlock = new Redlock([redisA, redisB, redisC]);

      const duration = 1000 * 8;

      // Set a value on redisB and redisC so that lock acquisition fails.
      await redisB.set("{redlock}c", "other1");
      await redisC.set("{redlock}c", "other2");

      // Acquire a lock.
      try {
        await redlock.acquire(["{redlock}c"], duration);
        throw new Error("This lock should not be acquired.");
      } catch (error) {
        if (!(error instanceof ExecutionError)) {
          throw error;
        }

        t.is(
          error.attempts.length,
          11,
          "A failed acquisition must have the configured number of retries."
        );

        t.is(await redisA.get("{redlock}c"), null);
        t.is(await redisB.get("{redlock}c"), "other1");
        t.is(await redisC.get("{redlock}c"), "other2");

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.assert(
                v instanceof ResourceLockedError,
                "The error was of the wrong type."
              );
              t.is(
                v.message,
                "The operation was applied to: 0 of the 1 requested resources."
              );
            }
          }
        }
      }

      await redisB.del("{redlock}c");
      await redisC.del("{redlock}c");
    } catch (error) {
      fail(t, error);
    }
  });

}

if (process.env.TEST_MULTI === 'instance') {
  const redisA = new Client({ host: "redis-multi-instance-a" });
  const redisB = new Client({ host: "redis-multi-instance-b" });
  const redisC = new Client({ host: "redis-multi-instance-c" });

  test.before('prepare', async () => {
    await wait(1000);
    const [keysA, keysB, keysC] = await Promise.all([
      redisA.keys("*"),
      redisB.keys("*"),
      redisC.keys("*"),
    ]);
    await Promise.allSettled([
      keysA?.length ? redisA.del(...keysA) : Promise.resolve(),
      keysB?.length ? redisB.del(...keysB) : Promise.resolve(),
      keysC?.length ? redisC.del(...keysC) : Promise.resolve(),
    ]);
    await wait(1000);

  });

  run(
    "multi instance",
    redisA,
    redisB,
    redisC
  );
  test.after.always(async () => {
    await Promise.allSettled([
      redisA.quit(),
      redisB.quit(),
      redisC.quit(),
    ]);
  }
  );

}
if (process.env.TEST_MULTI === 'cluster') {
  const clusterA = new Cluster([{ host: "redis-multi-cluster-a-1" }]);
  const clusterB = new Cluster([{ host: "redis-multi-cluster-b-1" }]);
  const clusterC = new Cluster([{ host: "redis-multi-cluster-c-1" }]);

  test.before('prepare', async () => {
    await wait(1000);
    await Promise.allSettled([
      waitForCluster(clusterA),
      waitForCluster(clusterB),
      waitForCluster(clusterC),
    ]);
    await wait(500);
    const [keysCA, keysCB, keysCC] = await Promise.all([
      clusterA.keys("*"),
      clusterB.keys("*"),
      clusterC.keys("*"),
    ]);
    await Promise.allSettled([
      keysCA?.length ? clusterA.del(...keysCA) : Promise.resolve(),
      keysCB?.length ? clusterB.del(...keysCB) : Promise.resolve(),
      keysCC?.length ? clusterC.del(...keysCC) : Promise.resolve(),
    ]);
    await wait(1000);
  });

  run(
    "multi cluster",
    clusterA,
    clusterB,
    clusterC
  );

  test.after.always(async () => {
    await Promise.allSettled([
      clusterA.quit(),
      clusterB.quit(),
      clusterC.quit(),
    ]);
  });

}
