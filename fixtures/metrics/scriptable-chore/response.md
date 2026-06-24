# Summary

Would run a deterministic chmod command over the selected shell scripts.

# Verification

Command not executed in fixture mode. Expected verification is `find <path> -name '*.sh' -perm -111`.
