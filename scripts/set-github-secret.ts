import { execFileSync } from 'node:child_process';

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const REPO = (process.env.GITHUB_REPOSITORY || 'herokkuu3-creator/NEW-REPO').trim();
const SECRET_NAME = 'CODEFORCES_RESIDENTIAL_PROXY';
const SECRET_VALUE = (process.env.CODEFORCES_RESIDENTIAL_PROXY || process.env.PROXY_LIST || '').trim();

async function main() {
  if (!GITHUB_TOKEN) {
    throw new Error('Missing GITHUB_TOKEN environment variable');
  }
  if (!SECRET_VALUE) {
    throw new Error('Missing CODEFORCES_RESIDENTIAL_PROXY or PROXY_LIST environment variable');
  }

  let sodium: any = null;
  try {
    const mod = await import('libsodium-wrappers' as string);
    sodium = mod?.default ?? mod;
  } catch {
    sodium = null;
  }

  if (!sodium) {
    execFileSync('gh', ['secret', 'set', SECRET_NAME, '--repo', REPO], {
      input: SECRET_VALUE,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || GITHUB_TOKEN },
    });
    console.log(`✅ Successfully set secret ${SECRET_NAME} on ${REPO} via gh CLI`);
    return;
  }

  await sodium.ready;

  // 1. Get public key
  const keyRes = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/public-key`, {
    headers: {
      authorization: `token ${GITHUB_TOKEN}`,
      'user-agent': 'node',
      accept: 'application/vnd.github.v3+json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!keyRes.ok) throw new Error(`Failed to get public key: ${keyRes.status} ${await keyRes.text()}`);
  const { key_id, key } = (await keyRes.json()) as { key_id: string; key: string };
  console.log(`Retrieved key_id: ${key_id}`);

  // 2. Encrypt secret
  const binkey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const binsec = sodium.from_string(SECRET_VALUE);
  const encBytes = sodium.crypto_box_seal(binsec, binkey);
  const encrypted_value = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);

  // 3. Put secret
  const putRes = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/${SECRET_NAME}`, {
    method: 'PUT',
    headers: {
      authorization: `token ${GITHUB_TOKEN}`,
      'user-agent': 'node',
      'content-type': 'application/json',
      accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      encrypted_value,
      key_id,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (putRes.status === 201 || putRes.status === 204) {
    console.log(`✅ Successfully set secret ${SECRET_NAME} on ${REPO} (Status: ${putRes.status})`);
  } else {
    console.error(`❌ Failed to set secret: ${putRes.status} ${await putRes.text()}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
