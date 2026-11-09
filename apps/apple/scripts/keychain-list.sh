# Sourced by scripts/signing-lib.sh. Saves, extends and restores the user's keychain search list (`security list-keychains -d user`),
# so a temporary signing keychain can be added for one run and the person's own list put back exactly afterwards.
# Bash 3.2 compatible (macOS /bin/bash).

# Prints the current user search list, one entry per line.
keychain_list_save() {
  security list-keychains -d user | sed -E 's/^[[:space:]]*"(.*)"[[:space:]]*$/\1/'
}

# Puts the list printed by keychain_list_save back. An empty saved list leaves the search list alone.
keychain_list_restore() {
  local saved="$1" entry; local -a items=()
  while IFS= read -r entry; do [[ -n "$entry" ]] && items+=("$entry"); done <<< "$saved"
  (( ${#items[@]} > 0 )) || return 0
  security list-keychains -d user -s "${items[@]}" >/dev/null 2>&1
}

# Adds a keychain in front of the current list. $2, when given, is appended if the list lacks it (the login keychain holds
# Apple's WWDR intermediates).
keychain_list_add() {
  local added="$1" fallback="${2:-}" entry; local -a items=("$added")
  while IFS= read -r entry; do [[ -n "$entry" && "$entry" != "$added" ]] && items+=("$entry"); done <<< "$(keychain_list_save)"
  if [[ -n "$fallback" ]]; then
    local found=0 p
    for p in "${items[@]}"; do [[ "$p" == "$fallback" ]] && found=1; done
    (( found )) || items+=("$fallback")
  fi
  security list-keychains -d user -s "${items[@]}" >/dev/null
}
