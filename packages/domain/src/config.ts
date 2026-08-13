import { type ProjectProfile } from './schemas.js';
import {
  generationConfigOverridesSchema,
  generationConfigValuesSchema,
  resolvedGenerationConfigSnapshotSchema,
  type GenerationConfigOverrides,
  type GenerationConfigValues,
  type ResolvedGenerationConfigSnapshot,
} from './schemas.js';

type ConfigLayer = 'default' | 'user' | 'project' | 'task';

export const DEFAULT_GENERATION_CONFIG: Readonly<GenerationConfigValues> = Object.freeze({
  model: 'deepseek-v4-pro',
  reasoningEffort: 'medium',
  targetChannel: '学院网站',
  maxWords: 1200,
  requestTimeoutMs: 120_000,
});

const keys = [
  'model',
  'reasoningEffort',
  'targetChannel',
  'maxWords',
  'requestTimeoutMs',
] as const satisfies readonly (keyof GenerationConfigValues)[];

export interface ResolveGenerationConfigInput {
  profile: ProjectProfile;
  defaults: GenerationConfigValues;
  user?: GenerationConfigOverrides;
  project?: GenerationConfigOverrides;
  task?: GenerationConfigOverrides;
}

export const resolveGenerationConfig = (
  input: ResolveGenerationConfigInput,
): ResolvedGenerationConfigSnapshot => {
  const defaults = generationConfigValuesSchema.parse(input.defaults);
  const layers: ReadonlyArray<readonly [ConfigLayer, GenerationConfigOverrides]> = [
    ['default', defaults],
    ['user', generationConfigOverridesSchema.parse(input.user ?? {})],
    ['project', generationConfigOverridesSchema.parse(input.project ?? {})],
    ['task', generationConfigOverridesSchema.parse(input.task ?? {})],
  ];
  const values = { ...defaults };
  const sources = Object.fromEntries(keys.map((key) => [key, 'default'])) as Record<
    (typeof keys)[number],
    ConfigLayer
  >;

  for (const [source, layer] of layers) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(layer, key)) {
        Object.assign(values, { [key]: layer[key] });
        sources[key] = source;
      }
    }
  }

  return resolvedGenerationConfigSnapshotSchema.parse({
    schemaVersion: 1,
    provider: 'deepseek',
    profile: input.profile,
    values,
    sources,
  });
};
