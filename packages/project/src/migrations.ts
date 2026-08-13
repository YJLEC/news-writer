import { ProjectError } from './errors.js';

export interface Migration<TFrom = unknown, TTo = unknown> {
  from: number;
  to: number;
  migrate(value: TFrom): TTo;
}

export const migrationRegistry: readonly Migration[] = Object.freeze([]);

export const getMigrationPath = (
  from: number,
  to: number,
  registry: readonly Migration[] = migrationRegistry,
): readonly Migration[] => {
  if (from === to) return [];
  const steps: Migration[] = [];
  let current = from;
  while (current < to) {
    const matches = registry.filter(
      (migration) => migration.from === current && migration.to === current + 1,
    );
    if (matches.length !== 1) {
      throw new ProjectError(
        'PROJECT_MIGRATION_FAILED',
        'No unique sequential project migration is available',
      );
    }
    const step = matches[0];
    if (step === undefined)
      throw new ProjectError('PROJECT_MIGRATION_FAILED', 'Project migration is missing');
    steps.push(step);
    current += 1;
  }
  return steps;
};
