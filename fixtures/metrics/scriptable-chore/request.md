# Objective

Normalize file permissions for generated shell scripts.

# Scope

Run one deterministic command over a known path set. Do not inspect file contents.

# Context

This represents a scriptable chore where bash can do the work directly. The model only needs to emit the command; there is no meaningful content volume to move into worker context.

# Acceptance criteria

All matching shell scripts are executable and no other files are changed.

# Verification

Report the command that would be run and its exit code.

# Constraints

Do not push. Prefer a direct deterministic command.
