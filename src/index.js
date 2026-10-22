// src/index.js — package entry point.
// The DSH loader expects a module exporting `apply` (and conventionally
// `name` / `Config`) — see src/dsh/adapter.js for the implementation and
// the verification notes at the top of that file.
//
// This is the file DSH's plugin loader points at directly. There is no
// build step: edit anything under src/ and restart DSH (Node has to
// reload the module either way — see README "Development workflow" for
// why a restart is still needed even without a compiler).

export { apply, name, inject, Config } from './dsh/adapter.js';
