<script lang="ts">
  // Settings entry point. The actual UI lives in settings/SettingsShell.svelte
  // (shell + PageSelector + section components) — Phase 1 of the
  // dashboard-settings migration (docs/plans/dashboard-settings-migration.md).
  // Kept as a wrapper so settings.astro and any future embedders keep a stable
  // import path while sections are added.
  import SettingsShell from './settings/SettingsShell.svelte'
</script>

<SettingsShell />
