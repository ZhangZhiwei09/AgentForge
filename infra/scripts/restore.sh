#!/bin/bash
# AgentForge PostgreSQL Restore Script
#
# 用法:
#   ./restore.sh <backup-file>                # 从指定文件恢复
#   ./restore.sh --latest                     # 从最新备份恢复
#   ./restore.sh --list                       # 列出所有可用备份
#
# ⚠️  警告：恢复操作会覆盖当前数据库中的所有数据！
#     请在执行前确认已停止应用服务且已备份当前数据。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${SCRIPT_DIR}/../../backups}"

parse_db_url() {
  local url="${DATABASE_URL:-}"
  if [ -z "$url" ]; then
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

list_backups() {
  if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]; then
    echo "No backups found in ${BACKUP_DIR}"
    exit 0
  fi
  echo "Available backups in ${BACKUP_DIR}:"
  echo "----------------------------------------"
  find "$BACKUP_DIR" -name "agentforge_*.sql.gz" -printf '%T+ %s %p\n' | sort -r | while read -r date size path; do
    echo "  $(basename "$path")  ($(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B")  ${date})"
  done
}

# --list 模式
if [ "${1:-}" = "--list" ]; then
  list_backups
  exit 0
fi

# 确定备份文件
BACKUP_FILE=""
if [ "${1:-}" = "--latest" ]; then
  BACKUP_FILE=$(find "$BACKUP_DIR" -name "agentforge_*.sql.gz" -printf '%T+ %p\n' | sort -r | head -1 | cut -d' ' -f2-)
  if [ -z "$BACKUP_FILE" ]; then
    echo "ERROR: No backups found in ${BACKUP_DIR}" >&2
    exit 1
  fi
elif [ -n "${1:-}" ]; then
  BACKUP_FILE="$1"
else
  echo "Usage: $0 <backup-file> | --latest | --list" >&2
  echo "" >&2
  list_backups
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

echo "⚠️  WARNING: This will OVERWRITE the current database with data from:"
echo "   $(basename "$BACKUP_FILE")"
echo ""
read -rp "Type 'RESTORE' to confirm: " CONFIRM
if [ "$CONFIRM" != "RESTORE" ]; then
  echo "Restore cancelled."
  exit 0
fi

DB_URL="$(parse_db_url)"

echo "Restoring from ${BACKUP_FILE}..."
gunzip -c "$BACKUP_FILE" | psql "$DB_URL"

echo "Restore complete."
echo "Run 'pnpm db:migrate' if the backup was from a different schema version."
