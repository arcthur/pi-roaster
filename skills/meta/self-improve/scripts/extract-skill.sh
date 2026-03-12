#!/usr/bin/env bash
# Brewva Skill Extraction Helper
# Delegates to the current skill-authoring scaffold so learnings promote into the
# current category layout instead of the removed tier model.

set -euo pipefail

DEFAULT_CATEGORY="core"
CATEGORY="$DEFAULT_CATEGORY"
OUTPUT_DIR="./skills/${DEFAULT_CATEGORY}"
OUTPUT_DIR_EXPLICIT=false
DRY_RUN=false
SKILL_NAME=""

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INIT_SCRIPT="$SCRIPT_DIR/../../skill-authoring/scripts/init_skill.py"
VALIDATION_SCRIPT="./skills/project/scripts/check-skill-dod.sh"

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

category_relative_dir() {
    case "$1" in
        overlay) echo "project/overlays" ;;
        *) echo "$1" ;;
    esac
}

default_output_dir() {
    local relative_dir
    relative_dir="$(category_relative_dir "$1")"
    echo "./skills/${relative_dir}"
}

usage() {
    cat << EOF
Usage: $(basename "$0") <skill-name> [options]

Create a Brewva skill scaffold from a learning entry.

Arguments:
  skill-name     Name of the skill (lowercase, hyphens)

Options:
  --category     Skill category: core|domain|operator|meta|overlay (default: core)
  --output-dir   Output directory (default: $(default_output_dir "$DEFAULT_CATEGORY"))
  --dry-run      Show the target command without creating files
  -h, --help     Show this help message

Examples:
  $(basename "$0") bun-test-isolation
  $(basename "$0") telegram-retry --category domain
  $(basename "$0") runtime-audit --category operator --output-dir ./skills/operator
  $(basename "$0") brewva-review --category overlay --output-dir ./skills/project/overlays
EOF
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --category)
            if [ -z "${2:-}" ] || [[ "${2:-}" == -* ]]; then
                log_error "--category requires: core|domain|operator|meta|overlay"
                exit 1
            fi
            CATEGORY="$2"
            case "$CATEGORY" in
                core|domain|operator|meta|overlay) ;;
                *)
                    log_error "Invalid category: $CATEGORY (use core|domain|operator|meta|overlay)"
                    exit 1
                    ;;
            esac
            if [ "$OUTPUT_DIR_EXPLICIT" = false ]; then
                OUTPUT_DIR="$(default_output_dir "$CATEGORY")"
            fi
            shift 2
            ;;
        --output-dir)
            if [ -z "${2:-}" ] || [[ "${2:-}" == -* ]]; then
                log_error "--output-dir requires a relative path"
                exit 1
            fi
            OUTPUT_DIR="$2"
            OUTPUT_DIR_EXPLICIT=true
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            if [ -z "$SKILL_NAME" ]; then
                SKILL_NAME="$1"
            else
                log_error "Unexpected argument: $1"
                usage
                exit 1
            fi
            shift
            ;;
    esac
done

if [ -z "$SKILL_NAME" ]; then
    log_error "Skill name is required"
    usage
    exit 1
fi

if ! [[ "$SKILL_NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    log_error "Invalid name format. Use lowercase letters, numbers, and hyphens."
    exit 1
fi

if [[ "$OUTPUT_DIR" = /* ]]; then
    log_error "Output directory must be a relative path."
    exit 1
fi

if [[ "$OUTPUT_DIR" =~ (^|/)\.\.(/|$) ]]; then
    log_error "Output directory cannot include '..' path segments."
    exit 1
fi

if [ ! -f "$INIT_SCRIPT" ]; then
    log_error "Missing scaffold helper: $INIT_SCRIPT"
    exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
    log_error "python3 is required to run the scaffold helper."
    exit 1
fi

if [ "$DRY_RUN" = true ]; then
    log_info "Dry run — would run:"
    echo "  python3 \"$INIT_SCRIPT\" \"$SKILL_NAME\" --category \"$CATEGORY\" --path \"$OUTPUT_DIR\""
    echo ""
    log_info "Validate with: $VALIDATION_SCRIPT <created-skill-dir>"
    exit 0
fi

log_info "Creating skill: $SKILL_NAME (category: $CATEGORY)"
init_output="$(python3 "$INIT_SCRIPT" "$SKILL_NAME" --category "$CATEGORY" --path "$OUTPUT_DIR")"
printf '%s\n' "$init_output"

created_dir="$(printf '%s\n' "$init_output" | sed -n 's/^Created .* skill: //p' | head -n 1)"
relative_created_dir="$created_dir"
if [[ -n "$created_dir" && "$created_dir" == "$PWD/"* ]]; then
    relative_created_dir="${created_dir#$PWD/}"
fi

echo ""
log_info "Skill scaffold created!"
echo ""
echo "Next steps:"
echo "  1. Edit ${relative_created_dir:-<created-skill-dir>}/SKILL.md — fill in the placeholder sections"
echo "  2. Add or trim references/ and scripts/ so the scaffold matches the real capability boundary"
echo "  3. Validate: $VALIDATION_SCRIPT ${relative_created_dir:-<created-skill-dir>}"
echo "  4. Update the source learning entry:"
echo "     **Status**: promoted_to_skill"
echo "     **Skill-Path**: ${relative_created_dir:-<created-skill-dir>}"
