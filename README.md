## 📖 系统概述

**Solana RFQ 系统** 是一个基于 OKX DEX 规范的生产级询价引擎，专为**高价值 RWA 与稳定币兑换**设计，实现**零滑点**与**原子化结算**。

### 核心优势

| 传统 AMM | Solana RFQ |
|----------|------------|
| 滑点高 | **零滑点** — 价格通过链下签名锁定 |
| 易受 MEV 攻击 | **抗 MEV** — 无可操纵的 DEX 池 |
| 结算风险 | **原子结算** — 两笔转账同时成功或回滚 |

### 适用场景

- **代币化股票**（如 Ondo 代币化股票）
- **代币化国债**（如 BUIDL、OUSG）
- **大额稳定币兑换**（USDC ↔ USDT）

---

## 🏗️ 架构与设计决策

### 零滑点原子结算

| 传统 AMM             | Solana RFQ 系统                           |
| -------------------- | ----------------------------------------- |
| 价格由池子比例决定   | 价格通过链下签名报价锁定                  |
| 订单越大滑点越高     | **零滑点** — 精确执行价格保证             |
| 易受 MEV/夹子攻击    | **抗 MEV** — 无可操纵的 DEX 池            |
| 波动期间存在结算风险 | **原子结算** — 两笔转账同时执行或全部回滚 |

**核心设计决策：**

1. **Taker 支付 Gas 模式**：Taker（报价接受方）承担交易费用，与做市商激励对齐并简化用户体验。
2. **确定报价模式**：Maker 签署包含明确 `expiry` 时间戳的链下报价。一旦签署，无论市场如何波动，价格均有保证。
3. **原子双端转账**：两笔代币转账（base → taker，quote → maker）在单笔交易中通过 CPI 完成，确保无部分成交。

### 燃气优化的 Ed25519 验证

采用**原生指令内省**而非昂贵的链上暴力验签（如 `secp256k1_recover` 或自定义加密系统调用）：

```rust
// 从 SYSVAR 读取 Ed25519 验证指令
// — Solana 运行时已通过预编译指令验证了签名
let prev_ix = load_instruction_at_checked(current_idx - 1, ix_sysvar)?;
```

**性能对比：**

| 指标          | 传统方案        | 该方案       |
| ------------- | --------------- | ------------ |
| 计算单元 (CU) | ~3,500 CU       | ~500 CU      |
| 失败率        | 较高（CU 限制） | **趋近于零** |
| 延迟          | 波动较大        | **确定性**   |

此优化对大额交易至关重要——交易失败可能导致**六位数的滑点成本**。

### 确定性防重放与严格所有权约束

**防重放攻击：**

```rust
// 每个 RFQ ID 仅能执行一次 — 记录于不可变 PDA
#[account(
    init,
    seeds = [RFQ_RECORD_SEED, rfq_id.as_ref()],
    bump
)]
pub rfq_record: Account<'info, RfqRecord>,
```

**所有权强制校验：**

```rust
// 每个代币账户均针对预期所有者进行验证
#[account(
    mut, 
    constraint = maker_quote_ata.owner == maker.key()
)]
pub maker_quote_ata: Account<'info, TokenAccount>,
```

这些约束**彻底消除了整类攻击**：

- 大额交易的重复支付攻击
- 通过恶意程序劫持代币账户
- 网络分叉期间的重放攻击

---

## 🔗 OKX 协议对齐

本实现严格遵守 OKX DEX 规范：

| 要求                          | 实现方式                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| **40 秒强制过期**             | 测试套件中 `expiry = now + 40s` 强制校验                     |
| **Base58 签名编码**           | 所有 Maker 签名使用 `bs58.encode(signature)`                 |
| **授权转账（Authority PDA）** | Maker 通过 `createApproveInstruction` 预授权 `rfq_authority` PDA |
| **指令排序**                  | Ed25519 在索引 0，`execute_trade` 在索引 1                   |

---

## 🚀 快速开始

### 环境准备

```bash
# 安装 Solana 工具套件
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# 安装 Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.29.0

# 安装依赖
yarn install
```

### 本地运行

```bash
# 终端 1：启动本地验证节点
solana-test-validator --reset

# 终端 2：部署程序
anchor build && anchor deploy

# 终端 3：启动后端 Aggregator 服务
cd backend
cargo run
# 后端将在 http://127.0.0.1:8080 启动
# Swagger UI: http://127.0.0.1:8080/swagger-ui

# 终端 4：运行端到端测试套件
npx ts-node tests/test_rfq_e2e.ts
```

### 环境变量配置

项目使用 `.env` 文件配置 Maker 私钥，确保后端和测试脚本使用相同的私钥：

```bash
# .env 文件内容
MAKER_PRIVATE_KEY=<Base58 encoded 64-byte keypair>
AGGREGATOR_PORT=8080
SOLANA_RPC_URL=http://127.0.0.1:8899
AGGREGATOR_URL=http://127.0.0.1:8080
```

生成新的测试私钥：
```bash
node -e "const crypto = require('crypto'); const bs58 = require('bs58'); console.log(bs58.encode(crypto.randomBytes(64)));"
```

### 示例输出

```
=== Solana RFQ End-to-End Test Suite ===

[Connection] Connected to Solana node: 2.3.10

Step 0: Initialize Test Keypairs
  [KeyGen] Provisioning SOL to test accounts...
  [KeyGen] Taker: 25JM6B473dJvMAG2cw1kUcW2dbnznr5XLxte7YR51Xjn
  [KeyGen] Maker: Bqff25dpGFBZoxzmNwvXTvv7K6LBKV5qyN2bD4YRzNGH
  [KeyGen] Payer: DvVrbiAQS5iDqKvCXhZ8czZDDtNLP1THwqotfENo14tD

Step 0.1: Provision Mock Token Infrastructure
  [TokenSetup] Initializing test token mint: 236eKA5CubVVzXBb3g6cdDWzGLjpeavn5sKws6VgGNfs
  [TokenSetup] Taker ATA: 6W9ByUGwSRSsgxDBAEPz6G3Z1nDPiWeoqaJp1Yu4gQwt
  [TokenSetup] Maker ATA: EaX9n5Uy1HVinChEMeeNej9gEziiLdzJSnQVPEXzniNx
  [TokenSetup] Initializing test token mint: E4ZW69dG5WpPiiYfMhVYX3cQZuc8vZSnVMTb8ezGvb1L
  [TokenSetup] Taker ATA: HuCc8yS33YJvJEve8DmSkXHhb6mVMRmMK9fogRweCMrc
  [TokenSetup] Maker ATA: Ap9LD4NCYQsdwLXfTane5Sn82cqpSjRhfNUdTt5wEFnr

Step 0.2: Maker Pre-Approves PDA for Token Delegation
  [Approval] Maker delegated Quote Token allowance to PDA: 7DKd7aGCrwKTFjMYYtNdvxT686oEWaJTwgR747692pxb

Step 1: Maker Generates Offline Quote & Cryptographic Signature
  [Quote] RFQ ID: f0873fcccdbb48b795c594d6d468008e
  [Quote] Base Token (SOL): 236eKA5CubVVzXBb3g6cdDWzGLjpeavn5sKws6VgGNfs
  [Quote] Quote Token (USDC): E4ZW69dG5WpPiiYfMhVYX3cQZuc8vZSnVMTb8ezGvb1L
  [Quote] Base Amount: 100000000
  [Quote] Quote Amount: 200000000
  [Quote] Expiry: 2026-04-06T13:36:58.000Z
  [Quote] Taker: 25JM6B473dJvMAG2cw1kUcW2dbnznr5XLxte7YR51Xjn
  [Quote] Sign Message: f0873fcccdbb48b795c594d6d468008e|236eKA5CubVVzXBb3g6cdDWzGLjpeavn5sKws6VgGNfs|E4ZW69dG5WpPiiYfMhVYX3cQZuc8vZSnVMTb8ezGvb1L|100000000|200000000|1775482618|25JM6B473dJvMAG2cw1kUcW2dbnznr5XLxte7YR51Xjn
  [Quote] Signature (Base58): bj87smLrC18oFKe7qwgae77ZTL55RsFFARRuw1vniKs2YVk8s8BmgvzNroVtZaCjmSWWCYhgGs8CVKJshb5UR9b

Step 2: Taker/Aggregator Assembles Atomic Settlement Transaction
  [Assembly] RFQ Record PDA: Fdb2yQjgWDZcqGFrurao62ii4ZM1hr2QZAESw6hz9Br8
  [Assembly] RFQ Authority PDA: 7DKd7aGCrwKTFjMYYtNdvxT686oEWaJTwgR747692pxb
  [Assembly] Added Ed25519 signature verification instruction
  [Assembly] Added execute_trade instruction

Step 3: Submit and Confirm On-Chain Settlement
  [Settlement] Transaction signed by Taker
  [Settlement] Transaction size: 1097 bytes
  [Settlement] Transaction confirmed on-chain!
  [Settlement] Transaction Signature: 4HqWoHnLJxGHrsyoVFk6JAwkLUL2Bo3s1bXeBDjX6d5H4msTfmvtweb32DmKpZpePiHcoUEmcymozHDJrCGq67NE
  [Settlement] Explorer: https://explorer.solana.com/tx/4HqWoHnLJxGHrsyoVFk6JAwkLUL2Bo3s1bXeBDjX6d5H4msTfmvtweb32DmKpZpePiHcoUEmcymozHDJrCGq67NE?cluster=custom&customUrl=http://127.0.0.1:8899

=== Post-Settlement Verification ===
[Verification] RFQ Record PDA successfully initialized
[Verification] PDA data size: 73 bytes

[Verification] Post-Settlement Token Balances:
  Taker Base Token: 0.9
  Maker Base Token: 1.1
  Taker Quote Token: 1.2
  Maker Quote Token: 0.8

=== RFQ E2E Test Suite Complete ===
```



## 🔒 安全考量

本系统按**生产部署**标准设计，提供以下安全保证：

1. **无升级权限**：程序部署时不保留升级权限，最大化去信任化
2. **不可变 RFQ 记录**：一旦执行，RFQ 记录无法修改
3. **PDA 隔离**：Authority PDA 不能持有 lamports，避免通过租金豁免攻击
4. **确定性执行**：所有约束在编译时尽可能评估

---

## 📦 交付物清单

### 1. 代码

| 组件 | 文件路径 | 说明 |
|------|----------|------|
| **链上程序** | `programs/solana_rfq/src/` | Solana 结算合约 |
| 结算指令 | `programs/solana_rfq/src/instructions/execute_trade.rs` | 核心 RFQ 结算逻辑 |
| 防重放记录 | `programs/solana_rfq/src/state/rfq_record.rs` | 不可变 RFQ 执行记录 |
| **链下服务** | `backend/src/` | Rust Aggregator 服务 |
| API 端点 | `backend/src/api.rs` | RFQ 请求和报价接口 |
| 做市商 | `backend/src/maker.rs` | Mock Market Maker 实现 |
| 数据模型 | `backend/src/models.rs` | 请求和报价数据结构 |

### 2. 可运行 Demo

| 脚本 | 文件路径 | 说明 |
|------|----------|------|
| **端到端测试** | `tests/test_rfq_e2e.ts` | 完整的 RFQ 流程演示 |
| 运行命令 | `npx ts-node tests/test_rfq_e2e.ts` | 一键运行测试套件 |

### 3. 说明文档 `README.md` 

---

## 📂 项目结构

```
solana-rfq/
├── programs/                          # 链上程序
│   └── solana_rfq/
│       └── src/
│           ├── lib.rs                 # 程序入口
│           ├── constants.rs           # PDA 种子与常量
│           ├── error.rs               # 自定义错误类型
│           ├── instructions/
│           │   ├── mod.rs
│           │   └── execute_trade.rs   # 核心 RFQ 结算逻辑
│           └── state/
│               ├── mod.rs
│               └── rfq_record.rs      # 不可变 RFQ 执行记录
├── backend/                           # 链下 Aggregator 服务
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs                    # 服务入口
│       ├── api.rs                     # API 路由和处理器
│       ├── models.rs                  # 数据模型定义
│       ├── maker.rs                   # Mock Market Maker 实现
│       └── error.rs                   # 错误类型定义
├── tests/
│   └── test_rfq_e2e.ts                # 端到端测试套件
├── migrations/
│   └── deploy.ts                      # 部署脚本
├── .env.example                       # 环境变量示例
├── README.md                          # 项目说明文档
=```

