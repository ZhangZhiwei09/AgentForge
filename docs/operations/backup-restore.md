# 数据库备份与恢复

## 备份

### 手动备份

```bash
cd infra/scripts
./backup.sh
```

备份文件存储在 `infra/scripts/../../backups/`（默认 `./backups/`），格式为 `agentforge_YYYYMMDD_HHMMSS.sql.gz`。

### 自动备份（cron）

在服务器上添加 crontab：

```bash
# 每日凌晨 3:00 执行备份
0 3 * * * /path/to/AgentForge/infra/scripts/backup.sh --cron >> /var/log/agentforge-backup.log 2>&1
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | 从 `.env` 读取 | PostgreSQL 连接串 |
| `BACKUP_DIR` | `./backups` | 备份存储目录 |
| `BACKUP_RETENTION` | `30` | 备份保留天数 |

### Docker 环境

如果 PostgreSQL 运行在 Docker 中：

```bash
# 从 Docker 容器内执行 pg_dump
docker exec -i agentforge-postgres-1 pg_dump -U postgres agentforge | gzip > backup.sql.gz

# 或使用 docker compose exec
docker compose -f infra/docker/docker-compose.yml exec -T postgres pg_dump -U postgres agentforge | gzip > backup.sql.gz
```

---

## 恢复

### 列出可用备份

```bash
./restore.sh --list
```

### 从最新备份恢复

```bash
./restore.sh --latest
```

### 从指定文件恢复

```bash
./restore.sh ../backups/agentforge_20260713_030000.sql.gz
```

恢复过程需要输入 `RESTORE` 确认，防止误操作。

### 恢复后操作

1. 运行数据库迁移（如备份与当前 schema 版本不同）：
   ```bash
   pnpm db:migrate
   ```

2. 重启应用服务：
   ```bash
   pnpm infra:restart
   pnpm dev
   ```

---

## 恢复演习

建议每季度执行一次恢复演习：

1. 在测试环境启动一个干净的 PostgreSQL 实例
2. 从生产备份恢复
3. 运行迁移
4. 验证关键数据完整性（用户数、会话数、知识库文档数）
5. 记录演习结果
