import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayLease } from "../src/registry/gateway-lease.ts";
import {
  createIlinkCredentialFile,
  IlinkCredentialStore,
  IlinkCredentialStoreError,
  isPosixCredentialPermissionSafe,
} from "../src/gateway/credential-store.ts";

const AUTHORIZED_USER_ID = "wx-test-user";

/**
 * 创建隔离的 manager 凭证测试目录。
 *
 * @returns manager 目录和固定凭证文件路径。
 */
async function createCredentialFixture(): Promise<{
  root: string;
  managerDirectory: string;
  credentialFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-wechat-credentials-"));
  const managerDirectory = join(root, "wechat-session-manager");
  await mkdir(managerDirectory, { recursive: true, mode: 0o700 });
  return {
    root,
    managerDirectory,
    credentialFile: join(managerDirectory, "credentials.json"),
  };
}

/**
 * 写入测试使用的独立 iLink credential record。
 *
 * @param credentialFile 固定凭证文件路径。
 * @param authorizedUserId 凭证声明的唯一授权用户。
 * @returns 无返回值。
 */
async function writeCredential(
  credentialFile: string,
  authorizedUserId = AUTHORIZED_USER_ID,
): Promise<void> {
  await writeFile(
    credentialFile,
    `${JSON.stringify({
      schemaVersion: 1,
      authorizedUserId,
      token: "fake-test-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function createStore(managerDirectory: string, credentialFile: string): IlinkCredentialStore {
  return new IlinkCredentialStore(managerDirectory, credentialFile, {
    platform: "win32",
    verifyWindowsAcl: async () => undefined,
  });
}

test(
  "Windows manager ACL integration 验证专属目录与 fake credential",
  {
    skip: process.platform !== "win32" ||
      process.env.PI_WECHAT_VERIFY_WINDOWS_ACL !== "1" ||
      !existsSync(join(homedir(), ".pi", "agent")),
  },
  async () => {
    const agentDirectory = join(homedir(), ".pi", "agent");
    const managerDirectory = await mkdtemp(join(agentDirectory, "pi-wechat-acl-test-"));
    const credentialFile = join(managerDirectory, "credentials.json");
    let lease: GatewayLease | undefined;
    try {
      lease = await GatewayLease.acquire(managerDirectory);
      await createIlinkCredentialFile(managerDirectory, {
        schemaVersion: 1,
        authorizedUserId: AUTHORIZED_USER_ID,
        token: "fake-test-token",
        baseUrl: "https://ilinkai.weixin.qq.com",
      });
      const credential = await new IlinkCredentialStore(managerDirectory, credentialFile)
        .load(AUTHORIZED_USER_ID);
      assert.equal(credential.token, "fake-test-token");
    } finally {
      await lease?.release();
      await rm(managerDirectory, { recursive: true, force: true });
    }
  },
);

test("POSIX credential 权限规则仅接受私有 manager/file 与不可被其他主体写入的父目录", () => {
  const safe = {
    managerMode: 0o40700,
    parentMode: 0o40755,
    fileMode: 0o100600,
    managerUid: 1000,
    fileUid: 1000,
    currentUid: 1000,
  };
  assert.equal(isPosixCredentialPermissionSafe(safe), true);
  assert.equal(isPosixCredentialPermissionSafe({ ...safe, parentMode: 0o40777 }), false);
  assert.equal(isPosixCredentialPermissionSafe({ ...safe, fileMode: 0o100644 }), false);
  assert.equal(isPosixCredentialPermissionSafe({ ...safe, managerMode: 0o40755 }), false);
  assert.equal(isPosixCredentialPermissionSafe({ ...safe, fileUid: 1001 }), false);
});

test("凭证 store 只读固定应用目录中的凭证并校验授权用户", async () => {
  const fixture = await createCredentialFixture();
  try {
    await writeCredential(fixture.credentialFile);
    let verifiedDirectory = "";
    let verifiedFile = "";
    const store = new IlinkCredentialStore(fixture.managerDirectory, fixture.credentialFile, {
      platform: "win32",
      verifyWindowsAcl: async (directory, file) => {
        verifiedDirectory = directory;
        verifiedFile = file;
      },
    });
    const credential = await store.load(AUTHORIZED_USER_ID);

    assert.deepEqual(credential, {
      token: "fake-test-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
    });
    assert.equal(verifiedDirectory, fixture.managerDirectory);
    assert.equal(verifiedFile, fixture.credentialFile);
    assert.match(await readFile(fixture.credentialFile, "utf8"), /fake-test-token/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("凭证 store 拒绝目录外路径且不会尝试读取", async () => {
  const fixture = await createCredentialFixture();
  try {
    const outsideCredentialFile = join(fixture.root, "outside.json");
    await writeCredential(outsideCredentialFile);
    const store = createStore(fixture.managerDirectory, outsideCredentialFile);

    await assert.rejects(
      store.load(AUTHORIZED_USER_ID),
      (error: unknown) => error instanceof IlinkCredentialStoreError && error.code === "credential_path_unsafe",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("凭证 store 拒绝授权用户不匹配、未知字段和空 allowlist", async () => {
  const fixture = await createCredentialFixture();
  try {
    await writeCredential(fixture.credentialFile, "wx-other-user");
    const store = createStore(fixture.managerDirectory, fixture.credentialFile);
    await assert.rejects(
      store.load(AUTHORIZED_USER_ID),
      (error: unknown) => error instanceof IlinkCredentialStoreError && error.code === "authorized_user_mismatch",
    );
    await assert.rejects(
      store.load(""),
      (error: unknown) => error instanceof IlinkCredentialStoreError && error.code === "authorized_user_mismatch",
    );

    await writeFile(
      fixture.credentialFile,
      JSON.stringify({
        schemaVersion: 1,
        authorizedUserId: AUTHORIZED_USER_ID,
        token: "fake-test-token",
        baseUrl: "https://ilinkai.weixin.qq.com",
        externalClientConfig: "must-not-be-accepted",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await assert.rejects(
      store.load(AUTHORIZED_USER_ID),
      (error: unknown) => error instanceof IlinkCredentialStoreError && error.code === "credential_invalid",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
