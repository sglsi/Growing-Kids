# 获取 DATABASE_URL 操作指引（Supabase 新版界面）

> 写于 2026-10-19。Supabase 界面已改版，**旧的「Project Settings → Database →
> Connection string」路径在新界面里找不到了**（我就是按旧路径找没找到才写的这篇）。
> 现在的主路径是：**打开项目后，点页面顶部的「Connect」按钮**。

---

## 一、最短路径（推荐照这个走）

### 1. 进项目

1. 浏览器打开 <https://supabase.com/dashboard> 并登录。
2. 在项目列表里点进 **Growing-Kids** 这个项目
   （项目 ref 是 `yjsuzunoxvyrblhuigpv`，URL 里能看到 `.../project/yjsuzunoxvyrblhuigpv`）。

> 如果你一登录就直接在某个项目里，先确认左上角显示的项目名对不对。

### 2. 点「Connect」

进入项目后，**看页面最上方**（项目名 / 面包屑那一行附近），有一个 **Connect** 按钮。
点它，会弹出一个连接信息面板。

> 找不到就留意这几个位置：
> - 页面右上角那一排按钮里；
> - 顶部工具栏的 `···`（更多）菜单里；
> - 旧界面里它在 **左下角齿轮 ⚙ → Project Settings → Database**。

### 3. 选「Session pooler」（**别选 Direct connection**）

面板里通常有这几项，含义和选法：

| 选项 | 端口 | 用户名长相 | 要不要选 |
|---|---|---|---|
| **Direct connection** | 5432 | `postgres` | ❌ **别选**。默认走 IPv6，国内家庭/办公宽带基本连不上，会卡在连接超时 |
| **Session pooler** | 5432 | `postgres.<项目ref>` | ✅ **选这个**。走 IPv4，且支持多语句事务 |
| Transaction pooler | 6543 | `postgres.<项目ref>` | ⚠️ 备选。不支持 prepared statement，我们的迁移脚本已规避，但优先级低于 Session pooler |
| Dedicated pooler | 6543 | `postgres` | 仅付费版有，可选 |

我们的项目在**新加坡**区，Session pooler 的串长这样（**以面板里实际显示的为准，不要照抄**）：

```
postgresql://postgres.yjsuzunoxvyrblhuigpv:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```

⚠️ **pooler 的主机名（含那个 `aws-0-xxx` 编号）无法自己拼出来**，同一个区域可能有多个集群。
必须**从 Connect 面板里复制**。

### 4. 换掉密码占位符

复制出来的串里密码位置是 `[YOUR-PASSWORD]`，把它换成真实数据库密码。

**忘了密码？** Supabase 只在建库时显示一次，之后不再展示。重置方法：
项目页 → 左下角齿轮 ⚙（Project Settings）→ **Database** → **Database password** → Reset。
重置后等 1～2 分钟生效（连续重置多次会更慢）。

⚠️ 密码里若有 `&` `#` `?` `@` 空格 这类字符：直接原样写进 `.env` 即可，
脚本内部会做 URL 编码；但如果你想手动拼 URL，就得先编码（`空格→%20`、`#→%23` 等）。

### 5. 写进 `.env`

在 `server/.env` 里加一行（**不要加引号**）：

```bash
DATABASE_URL=postgresql://postgres.yjsuzunoxvyrblhuigpv:你的密码@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```

`.env` 已在 `.gitignore` 里，不会提交。

---

## 二、验证连接串（先跑这个，别急着迁移）

```bash
node server/scripts/migrate.mjs --ping
```

成功会打印 Postgres 版本 + public schema 现有的表清单，例如：

```
[migrate] ✓ 连接成功
   Postgres: PostgreSQL 17.x
   public 表 11 张：blob_objects, chat_messages, documents, health_check, ...
```

失败会给出针对性提示（最常见的就是上面说的"选了 Direct connection 走 IPv6 连不上"）。

**确认 ping 通了，再跑真正的迁移：**

```bash
node server/scripts/migrate.mjs            # 执行未执行过的迁移
node server/scripts/migrate.mjs --dry      # 先看会执行哪些（不连库）
node server/scripts/migrate.mjs --force    # 忽略记录全部重跑（脚本都是幂等的）
```

---

## 三、常见坑速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 连不上 / 超时 | 用了 Direct connection（IPv6） | 换 Session pooler |
| `FATAL: Password authentication failed` | 密码错 | 去 Settings → Database 重置密码 |
| `ENOTFOUND db.xxx.supabase.co` | 直连且本机不支持 IPv6 | 换 Session pooler |
| 拿到串但还是报 `PGRST205 找不到表` | 建完表没刷 PostgREST 缓存 | 迁移脚本会自动执行 `notify pgrst, 'reload schema'`；手工执行的话要自己加这一句 |
| 把 anon / service_role key 当 DATABASE_URL 填了 | 那是 REST API 密钥，不是连接串 | 连接串一定是 `postgresql://` 开头 |

---

## 四、实在拿不到连接串的保底方案

不配 DATABASE_URL 也能建表：把 `docs/补建缺失表-一键SQL.sql` 整段复制，
粘进 Supabase 的 **SQL Editor** 执行（它就在项目页左侧菜单，图标像 `</>` 或标着 SQL Editor）。

缺点：不能记录"哪些迁移跑过"，下次新增迁移还得手工粘一次 —— 这也是我写迁移脚本的原因。
