import { formatWithOptions } from "util";
import test, { ExecutionContext } from "ava";
import Redis, { Redis as Client, Cluster } from "ioredis";
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

function run(namespace: string, redis: Client | Cluster
): void {


  test(`${namespace} - refuses to use a non-integer duration`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 0.1;

      // Acquire a lock.
      await redlock.acquire(["{redlock}float"], duration);

      t.fail("Expected the function to throw.");
    } catch (error) {
      t.is(
        (error as Error).message,
        "Duration must be an integer value in milliseconds."
      );
    }
  });

  test(`${namespace} - acquires, extends, and releases a single lock`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 1000 * 5;

      // Acquire a lock.
      let lock = await redlock.acquire(["{redlock}sl0"], duration);
      t.is(
        await redis.get("{redlock}sl0"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redis.pttl("{redlock}sl0")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redis.get("{redlock}sl0"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redis.pttl("{redlock}sl0")) / 200),
        Math.round((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}sl0"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - releasing expired lock doesn't fail`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 1000;

      // Acquire a lock.
      const lock = await redlock.acquire(["{redlock}ael1"], duration);

      // Wait for duration + drift to be sure that lock has expired
      await wait(duration + redlock.calculateDrift(duration));

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}ael1"), null, "The lock was not released");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - acquires, extends, and releases a multi-resource lock`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 1000 * 5;

      // Acquire a lock.
      let lock = await redlock.acquire(
        ["{redlock}m1", "{redlock}m2"],
        duration
      );
      t.is(
        await redis.get("{redlock}m1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redis.get("{redlock}m2"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redis.pttl("{redlock}m1")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redis.pttl("{redlock}m2")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Extend the lock.
      lock = await lock.extend(3 * duration);
      t.is(
        await redis.get("{redlock}m1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redis.get("{redlock}m2"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redis.pttl("{redlock}m1")) / 200),
        Math.round((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redis.pttl("{redlock}m2")) / 200),
        Math.round((3 * duration) / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}m1"), null);
      t.is(await redis.get("{redlock}m2"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - releasing expired multi-resource lock doesn't fail`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 1000;

      // Acquire a lock.
      const lock = await redlock.acquire(
        ["{redlock}mf1", "{redlock}mf2"],
        duration
      );

      // Wait for duration + drift to be sure that lock has expired
      await wait(duration + redlock.calculateDrift(duration));

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}mf1"), null, "The lock was not released");
      t.is(await redis.get("{redlock}mf2"), null, "The lock was not released");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - locks fail when redis is unreachable`, async (t) => {
    try {
      const redis = new Client({
        host: "127.0.0.1",
        maxRetriesPerRequest: 0,
        autoResendUnfulfilledCommands: false,
        autoResubscribe: false,
        retryStrategy: () => null,
        reconnectOnError: () => false,
      });

      redis.on("error", () => {
        // ignore redis-generated errors
      });

      const redlock = new Redlock([redis]);

      const duration = 1000 * 5;
      try {
        await redlock.acquire(["{redlock}unreach"], duration);
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

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.is(v.message, "Connection is closed.");
            }
          }
        }
      }
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - locks automatically expire`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 200;

      // Acquire a lock.
      const lock = await redlock.acquire(["{redlock}autoexp"], duration);
      t.is(
        await redis.get("{redlock}autoexp"),
        lock.value,
        "The lock value was incorrect."
      );

      // Wait until the lock expires.
      await new Promise((resolve) => setTimeout(resolve, 300, undefined));

      // Attempt to acquire another lock on the same resource.
      const lock2 = await redlock.acquire(["{redlock}autoexp"], duration);
      t.is(
        await redis.get("{redlock}autoexp"),
        lock2.value,
        "The lock value was incorrect."
      );

      // Release the lock.
      await lock2.release();
      t.is(await redis.get("{redlock}autoexp"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - individual locks are exclusive`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 1000 * 10;

      // Acquire a lock.
      const lock = await redlock.acquire(["{redlock}ile"], duration);
      t.is(
        await redis.get("{redlock}ile"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redis.pttl("{redlock}ile")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Attempt to acquire another lock on the same resource.
      try {
        await redlock.acquire(["{redlock}ile"], duration);
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

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.assert(
                v instanceof ResourceLockedError,
                "The error must be a ResourceLockedError."
              );
            }
          }
        }
      }

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}ile"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - overlapping multi-locks are exclusive`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 1000 * 10;

      // Acquire a lock.
      const lock = await redlock.acquire(
        ["{redlock}mle1", "{redlock}mle2"],
        duration
      );
      t.is(
        await redis.get("{redlock}mle1"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        await redis.get("{redlock}mle2"),
        lock.value,
        "The lock value was incorrect."
      );
      t.is(
        Math.round((await redis.pttl("{redlock}mle1")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );
      t.is(
        Math.round((await redis.pttl("{redlock}mle2")) / 200),
        Math.round(duration / 200),
        "The lock expiration was off by more than 200ms"
      );

      // Attempt to acquire another lock with overlapping resources
      try {
        await redlock.acquire(["{redlock}mle2", "{redlock}mle3"], duration);
        throw new Error("This lock should not be acquired.");
      } catch (error) {
        if (!(error instanceof ExecutionError)) {
          throw error;
        }

        t.is(
          await redis.get("{redlock}mle1"),
          lock.value,
          "The original lock value must not be changed."
        );
        t.is(
          await redis.get("{redlock}mle2"),
          lock.value,
          "The original lock value must not be changed."
        );
        t.is(
          await redis.get("{redlock}mle3"),
          null,
          "The new resource must remain unlocked."
        );

        t.is(
          error.attempts.length,
          11,
          "A failed acquisition must have the configured number of retries."
        );

        for (const e of await Promise.allSettled(error.attempts)) {
          t.is(e.status, "fulfilled");
          if (e.status === "fulfilled") {
            for (const v of e.value?.votesAgainst?.values()) {
              t.assert(
                v instanceof ResourceLockedError,
                "The error must be a ResourceLockedError."
              );
            }
          }
        }
      }

      // Release the lock.
      await lock.release();
      t.is(await redis.get("{redlock}mle1"), null);
      t.is(await redis.get("{redlock}mle2"), null);
      t.is(await redis.get("{redlock}mle3"), null);
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - the \`using\` helper acquires, extends, and releases locks`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 500;

      const valueP: Promise<string | null> = redlock.using(
        ["{redlock}xusing"],
        duration,
        {
          automaticExtensionThreshold: 200,
        },
        async (signal) => {
          const lockValue = await redis.get("{redlock}xusing");
          t.assert(
            typeof lockValue === "string",
            "The lock value was not correctly acquired."
          );

          // Wait to ensure that the lock is extended
          await new Promise((resolve) => setTimeout(resolve, 700, undefined));

          t.is(signal.aborted, false, "The signal must not be aborted.");
          t.is(signal.error, undefined, "The signal must not have an error.");

          t.is(
            await redis.get("{redlock}xusing"),
            lockValue,
            "The lock value should not have changed."
          );

          return lockValue;
        }
      );

      await valueP;

      t.is(await redis.get("{redlock}xusing"), null, "The lock was not released.");
    } catch (error) {
      fail(t, error);
    }
  });

  test(`${namespace} - the \`using\` helper is exclusive`, async (t) => {
    try {
      const redlock = new Redlock([redis]);

      const duration = 500;

      let locked = false;
      const [lock1, lock2] = await Promise.all([
        await redlock.using(
          ["{redlock}yusing"],
          duration,
          {
            automaticExtensionThreshold: 200,
          },
          async (signal) => {
            t.is(locked, false, "The resource must not already be locked.");
            locked = true;

            const lockValue = await redis.get("{redlock}yusing");
            t.assert(
              typeof lockValue === "string",
              "The lock value was not correctly acquired."
            );

            // Wait to ensure that the lock is extended
            await new Promise((resolve) => setTimeout(resolve, 700, undefined));

            t.is(signal.error, undefined, "The signal must not have an error.");
            t.is(signal.aborted, false, "The signal must not be aborted.");

            t.is(
              await redis.get("{redlock}yusing"),
              lockValue,
              "The lock value should not have changed."
            );

            locked = false;
            return lockValue;
          }
        ),
        await redlock.using(
          ["{redlock}yusing"],
          duration,
          {
            automaticExtensionThreshold: 200,
          },
          async (signal) => {
            t.is(locked, false, "The resource must not already be locked.");
            locked = true;

            const lockValue = await redis.get("{redlock}yusing");
            t.assert(
              typeof lockValue === "string",
              "The lock value was not correctly acquired."
            );

            // Wait to ensure that the lock is extended
            await new Promise((resolve) => setTimeout(resolve, 700, undefined));

            t.is(signal.error, undefined, "The signal must not have an error.");
            t.is(signal.aborted, false, "The signal must not be aborted.");

            t.is(
              await redis.get("{redlock}yusing"),
              lockValue,
              "The lock value should not have changed."
            );

            locked = false;
            return lockValue;
          }
        ),
      ]);

      t.not(lock1, lock2, "The locks must be different.");

      t.is(await redis.get("{redlock}yusing"), null, "The lock was not released.");
    } catch (error) {
      fail(t, error);
    }
  });



}

if (process.env.TEST_SINGLE === 'instance') {

  const redis = new Client({ host: "redis-single-instance" });

  test.before('prepare', async () => {
    await wait(1000);
    const keys = await redis
      .keys("*")

    if (keys.length) {
      await redis.del(...keys);
    }
    await wait(1000);

  });
  run("single instance", redis);
  test.after.always('cleanup', async () => {
    await redis.quit();
  });
}

if (process.env.TEST_SINGLE === 'cluster') {
  const cluster = new Cluster([{ host: "redis-single-cluster-1" }]);

  test.before('prepare', async () => {
    await wait(1000);
    await waitForCluster(cluster);
    const keysC = await cluster
    .keys("*")

    if (keysC.length) {
      await cluster.del(...keysC);
    }
  });

  run("single cluster", cluster);

  test.after.always('cleanup', async () => {
    await cluster.quit();
  });
}