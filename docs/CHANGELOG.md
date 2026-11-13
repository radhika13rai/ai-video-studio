# Changelog

## 0.5.0 (2026-11-13)

- Task 5: project dashboard: list with status badges, filters, paging and polling; New video form
  with validation and duplicate protection; project page with rename and delete; status page;
  responsive layout. Validated API client. 22 new frontend tests and a browser end-to-end run.

## 0.4.0 (2026-11-12)

- Task 4: project API (`/me`, create, list, get, patch, delete, scenes, jobs, assets, quality),
  Cloudflare Access JWT verification with a local developer identity, fail-closed production
  default, shared error envelope with new codes, 64 KB JSON limit, Idempotency-Key support
  (migration 0002), small router. 24 new tests.

## 0.3.0 (2026-11-12)

- Task 3: migration `0001_initial_schema.sql` (nine tables, indexes, CHECK constraints) and typed
  repository functions for every table, with ownership enforced in SQL, Zod-validated JSON, job
  retry policy and transactional storyboard replacement. 28 new tests.

## 0.2.0 (2026-11-12)

- Task 2: D1, R2 and Workflows bindings; health endpoint reports binding status; stub
  `ProductionWorkflow`; Worker tests in workerd; `scripts/validate-env.sh` deploy guard; app shell
  shows each binding.

## 0.1.0 (2026-11-12)

- Task 1: monorepo foundation, health endpoint, app shell, shared contracts, tests.
