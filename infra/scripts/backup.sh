#!/bin/bash
# AgentForge PostgreSQL Backup Script
#
# 用法:
#   ./backup.sh                    # 手动执行一次备份
#   ./backup.sh --cron             # cron 模式（静默输出）
#
# 添加到 crontab（每日凌晨 3:00）:
#   0 3 * * * /path/to/backup.sh --cron >> /var/log/agentforge-backup.log 2>&1
#
# 环境变量（从 .env 或直接设置）:
#   DATABASE_URL      — PostgreSQL 连接串
#   BACKUP_DIR        — 备份存储目录（默认 ./backups）
#   BACKUP_RETENTION  — 保留天数（默认 30）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${SCRIPT_DIR}/../../backups}"
RETENTION_DAYS="${BACKUP_RETENTION:-30}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/agentforge_${TIMESTAMP}.sql.gz"

# 解析 DATABASE_URL: postgresql://user:pass@host:port/dbname
parse_db_url() {
  local url="${DATABASE_URL:-}"
  if [ -z "$url" ]; then
    # 尝试从 .env 加载
    if [ -f "${SCRIPT_DIR}/../../.env" ]; then
      url="$(grep -E '^DATABASE_URL=' "${SCRIPT_DIR}/../../.env" | cut -d'=' -f2-)"
    fi
  fi
  if [ -z "$url" ]; then
    echo "ERROR: DATABASE_URL not set" >&2
    exit 1
  fi
  echo "$url"
}

log() {
  if [ "${1:-}" != "--cron" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  fi
}

CRON_MODE=false
if [ "${1:-}" = "--cron" ]; then
  CRON_MODE=true
  shift
fi

# 确保备份目录存在
mkdir -p "$BACKUP_DIR"

DB_URL="$(parse_db_url)"

log "Starting backup to ${BACKUP_FILE}..."

if pg_dump "$DB_URL" --no-owner --no-acl | gzip > "$BACKUP_FILE"; then
  SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
  log "Backup complete: ${BACKUP_FILE} (${SIZE})"
else
  log "Backup FAILED"
  exit 1
fi

# 清理旧备份
DELETED=$(find "$BACKUP_DIR" -name "agentforge_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete -print 2>/dev/null | wc -l)
if [ "$DELETED" -gt 0 ]; then
  log "Cleaned up ${DELETED} old backup(s) (older than ${RETENTION_DAYS} days)"
fi

# 保留最近 N 天的备份 + 最少保留 7 个
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "agentforge_*.sql.gz" | wc -l)
log "Total backups: ${BACKUP_COUNT}"
