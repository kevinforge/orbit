# Orbit 商业授权系统

Orbit 使用 RSA 签名验证的商业授权系统，防止未授权使用。

## 授权流程

```
用户购买 → 生成机器码 → 创建 license.json → 用户安装 → 启动验证
```

## 用户使用说明

### 1. 获取机器码

运行以下命令获取机器码：

```powershell
orbit --machine-id
```

将输出的机器码发送给客服。

### 2. 安装授权文件

将收到的 `license.json` 文件放到以下任一位置：

- `./license.json`（可执行文件同级目录）
- `~/.orbit/license.json`（用户主目录）

### 3. 启动验证

启动 Orbit 时会自动验证授权：

```powershell
orbit
```

验证失败会显示错误信息并退出。

### 授权文件格式

```json
{
  "licenseId": "LIC-xxxx-xxxx",
  "customerId": "CUS-xxxx",
  "machineId": "sha256-hash-of-hardware",
  "expiresAt": "2025-12-31T23:59:59Z",
  "features": ["core"],
  "signature": "base64-encoded-rsa-signature"
}
```

### 验证失败原因

| 错误信息 | 原因 |
|----------|------|
| License file not found | 未找到 license.json 文件 |
| Invalid or corrupted license file | license 文件格式错误 |
| License machine ID mismatch | 机器码不匹配（换电脑了） |
| License signature verification failed | 签名验证失败（文件被篡改） |
| License expired or time rollback detected | 已过期或检测到系统时间回滚 |

---

## 管理员指南：生成授权

### 1. 生成密钥对（首次设置）

运行密钥生成脚本：

```powershell
node scripts/generate-keys.mjs
```

脚本会自动：
- 生成 RSA 2048-bit 密钥对
- 将公钥写入 `src/license/constants.ts`
- 将私钥保存到 `private.pem`（已在 .gitignore 中排除）

**私钥备份清单（必须完成全部）：**

- [ ] 复制 private.pem 到加密 U 盘
- [ ] 存储副本到安全云 vault（1Password 等）
- [ ] 打印副本存储到物理保险箱
- [ ] 与信任的团队成员分持（多人保管）
- [ ] 备份完成后从开发机器删除 private.pem

**重要提醒：**
- 私钥丢失 = 需要重新发布 Orbit，所有已发授权失效
- 私钥泄露 = 任何人都可以生成授权
- 建议使用离线机器生成和存储私钥

### 2. 生成 License

使用授权生成脚本：

```powershell
node scripts/generate-license.mjs --customer <客户ID> --machine <机器码> --expires <过期日期> --features core
```

参数说明：

| 参数 | 说明 | 示例 |
|------|------|------|
| `--customer` | 客户标识 | `CUS-001` |
| `--machine` | 用户提供的机器码 | `abc123...` |
| `--expires` | 过期时间 | `2025-12-31` |
| `--features` | 功能模块（逗号分隔） | `core,pro` |

### 示例

```powershell
# 生成一年期授权
node scripts/generate-license.mjs --customer CUS-001 --machine abc123def456 --expires 2025-12-31 --features core

# 输出 license.json 内容，发送给用户
```

---

## 安全机制

### 1. 机器码生成

机器码由以下硬件信息 SHA256 哈希生成：

- MAC 地址（首选，非虚拟网卡）
- CPU 信息（备选）
- 主板 UUID（备选）

### 2. 签名验证

使用 RSA-SHA256 签名，确保 license 无法被篡改：

```
签名数据 = { licenseId, customerId, machineId, expiresAt, features }
签名 = RSA-SHA256(签名数据, 私钥)
验证 = 验证签名(签名数据, 签名, 公钥)
```

### 3. 时间回滚检测

首次运行时记录时间戳到 `~/.orbit/.install-time`：

- 如果系统时间早于记录时间，判定为时间回滚
- 防止用户修改系统时间绕过过期检查

### 4. 源码保护

独立可执行文件使用 Bun 字节码编译：

- `--bytecode` - JS 编译为字节码
- `--minify` - 代码压缩
- `--sourcemap=none` - 无 source map

---

## 常见问题

### Q: 用户换电脑了怎么办？

A: 重新获取新机器的机器码，生成新的 license 文件。

### Q: 如何延长授权期限？

A: 生成新的 license 文件发给用户，覆盖原文件即可。

### Q: 私钥丢失了怎么办？

A: 重新生成密钥对，更新代码中的公钥，所有已发出的 license 需要重新生成。

### Q: 如何添加新功能模块？

A: 在 license 的 `features` 字段中添加，代码中通过检查该字段控制功能访问。