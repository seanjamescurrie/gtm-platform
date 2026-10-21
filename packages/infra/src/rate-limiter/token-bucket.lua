-- Token bucket, run atomically by Valkey (hand-written, #10 checkpoint 1).
--
-- KEYS[1]  the bucket's hash key; fields `tokens` and `updatedAt` (ms)
-- ARGV[1]  capacity: the most tokens the bucket can hold
-- ARGV[2]  refill rate, in tokens per second
-- ARGV[3]  cost of this request, in tokens
--
-- Returns { allowed (1 or 0), retryAfterMs (integer, 0 when allowed), tostring(tokensLeft) }
-- Directions: docs/learningPath/issue-10-rate-limiter.md, Part 1b.

-- ARGV always arrives as strings; without tonumber, `tokens >= cost` would compare text.
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

-- Valkey's clock, not the caller's, so every worker refills from the same time.
-- TIME returns { seconds, microseconds } as strings.
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

-- A missing field comes back as false, and tonumber(false) is nil, so `or` supplies the default:
-- a bucket that doesn't exist yet (or has expired) starts full.
local stored = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(stored[1]) or capacity
local lastUpdatedAt = tonumber(stored[2]) or nowMs

-- Never refill from a negative elapsed time: a failover to a replica can step the clock back.
local elapsedMs = math.max(0, nowMs - lastUpdatedAt)
tokens = math.min(capacity, tokens + elapsedMs / 1000 * refillRate)

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'updatedAt', nowMs)
  -- Once the bucket would be full again, a missing key means the same thing, so let it expire.
  -- At least 1 ms: PEXPIRE with 0 would delete the key at once.
  local ttlMs = math.max(1, math.ceil((capacity - tokens) / refillRate * 1000))
  redis.call('PEXPIRE', KEYS[1], ttlMs)
  -- tokens is usually fractional, and Lua cuts fractions to integers on return, so send a string.
  return { 1, 0, tostring(tokens) }
end

-- Refused: nothing is written. The stored pair still means "this many tokens as of updatedAt", so
-- the next call refills from the same point and nothing is lost. The expiry set by the last
-- allowed take is still right, because a refusal doesn't change when the bucket will be full.
-- Skipping the write also saves one on every refusal, which is when the limiter is busiest.
-- Round the wait up: rounding down would bring the caller back a moment early, to be refused again.
local retryAfterMs = math.ceil((cost - tokens) / refillRate * 1000)
return { 0, retryAfterMs, tostring(tokens) }
