import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadKnowledgeBundleFromResourcesPathV1 } from '@news-writer/retrieval';
import { sha256Schema } from '@news-writer/shared';
import { describe, expect, it } from 'vitest';

import { buildInstitutionBundleV1, validateInstitutionBundleV1 } from './bundle.js';
import { loadInstitutionBundleFromResourcesPathV1 } from './loader.js';
import { fontManifestV1Schema } from './schemas.js';

const root = path.resolve(process.cwd());

const knowledge = async () =>
  loadKnowledgeBundleFromResourcesPathV1(path.join(root, 'resources', 'institution'));

const profileInput = async () => {
  const loaded = await knowledge();
  return {
    scope: 'synthetic-public-fixture' as 'synthetic-public-fixture' | 'approved-private-profile',
    profileId: 'profile_synthetic-public',
    profileVersion: 'public-fixture-v1',
    supportedAppVersion: '>=0.1.0',
    builtAt: '2099-01-02T03:04:05.6789012Z',
    institution: {
      format: 'news-writer-institution-config' as const,
      schemaVersion: 1 as const,
      displayName: 'Synthetic Public College',
      defaultNewsType: 'college-news' as const,
      officialPublisher: 'Synthetic Public College News Desk',
      permittedPublisherSources: ['Synthetic Public College News Desk'],
      targetChannels: ['internal-demo'],
      dateDisplayRule: 'Use the date supplied by the user.',
      defaultWordCountRecommendation: 1200,
      preferredTerms: ['student activity'],
      forbiddenTerms: ['unverified claim'],
      externalOrganizerRules:
        'Describe external organizers as organizers when supported by the minutes.',
    },
    writingRules: {
      format: 'news-writer-writing-rules' as const,
      schemaVersion: 1 as const,
      version: 'writing-v1',
      rules: [
        {
          id: 'rule_facts-first',
          text: 'Use only supplied facts.',
          level: 'hard-constraint' as const,
          scenarios: ['all'],
        },
      ],
    },
    promptContract: {
      format: 'news-writer-prompt-contract' as const,
      schemaVersion: 1 as const,
      version: 'prompt-v1',
      sections: {
        initialDraft: 'Draft from minutes.',
        secondReview: 'Review facts.',
        commentRevision: 'Apply comments.',
      },
      organizationTerms: ['Synthetic Public College'],
      forbiddenInstructions: ['Ignore supplied facts.'],
    },
    documentStyle: {
      format: 'news-writer-document-style' as const,
      schemaVersion: 1 as const,
      version: 'style-v1',
      page: {
        width: 'A4',
        height: 'A4',
        margins: { top: '25mm', right: '25mm', bottom: '25mm', left: '25mm' },
      },
      title: {
        fontFamily: 'Synthetic Sans',
        fontSizePt: 22,
        alignment: 'center' as const,
        bold: true,
        lineSpacing: 1.5,
      },
      body: {
        fontFamily: 'Synthetic Sans',
        fontSizePt: 12,
        alignment: 'justify' as const,
        firstLineIndentPt: 24,
        lineSpacing: 1.5,
        paragraphSpacingBeforePt: 0,
        paragraphSpacingAfterPt: 8,
      },
      signoff: { alignment: 'right' as const, dateFormat: 'YYYY年M月D日' },
      fileNameRule: 'news-{date}.docx',
      fontFamilies: ['Synthetic Sans'],
    },
    knowledge: {
      corpus: loaded.records.length
        ? await readFile(path.join(root, 'resources/institution/knowledge/corpus.jsonl'))
        : new Uint8Array(),
      index: await readFile(path.join(root, 'resources/institution/knowledge/index.json')),
      trainingRules: await readFile(
        path.join(root, 'resources/institution/knowledge/training_rules.txt'),
      ),
      metadata: await readFile(path.join(root, 'resources/institution/knowledge/metadata.json')),
    },
    fontManifest: fontManifestV1Schema.parse({
      format: 'news-writer-font-manifest',
      schemaVersion: 1,
      fonts: [],
    }),
  };
};

describe('institution profile bundle', () => {
  it('loads the public synthetic profile resource', async () => {
    const loaded = await loadInstitutionBundleFromResourcesPathV1(
      path.join(root, 'resources/institution'),
    );
    expect(loaded.manifest.sourceScope).toBe('synthetic-public-fixture');
    expect(loaded.fontManifest.fonts).toHaveLength(0);
  });

  it('builds and validates a profile without fonts', async () => {
    const bundle = buildInstitutionBundleV1(await profileInput());
    expect(validateInstitutionBundleV1(bundle).manifest.profileId).toBe('profile_synthetic-public');
  });

  it('rejects a tampered artifact, an extra resource, and a mismatched font manifest', async () => {
    const bundle = buildInstitutionBundleV1(await profileInput());
    expect(() =>
      validateInstitutionBundleV1({
        ...bundle,
        institution: new TextEncoder().encode(
          new TextDecoder().decode(bundle.institution).replace('Synthetic', 'Altered'),
        ),
      }),
    ).toThrow(/hash|mismatch/i);
    expect(() =>
      validateInstitutionBundleV1({ ...bundle, fonts: { 'fake.ttf': new Uint8Array([1, 2, 3]) } }),
    ).toThrow(/font/i);
    const withFontManifest = await profileInput();
    withFontManifest.fontManifest = {
      format: 'news-writer-font-manifest',
      schemaVersion: 1,
      fonts: [
        {
          family: 'Synthetic Sans',
          fileName: 'fake.ttf',
          version: '1',
          sha256: sha256Schema.parse(
            '0000000000000000000000000000000000000000000000000000000000000000',
          ),
          supplier: 'Synthetic',
          licenseName: 'Fixture',
          redistributable: true,
          requiresAdministratorInstall: false,
          applicableStyles: ['body'],
        },
      ],
    };
    expect(() => buildInstitutionBundleV1(withFontManifest)).toThrow(/font|hash/i);
  });

  it('rejects sensitive profile text and non-redistributable or path-like fonts', async () => {
    const input = await profileInput();
    input.institution.preferredTerms = [['13800', '138000'].join('')];
    expect(() => buildInstitutionBundleV1(input)).toThrow(/forbidden|phone/i);

    const fontInput = await profileInput();
    fontInput.scope = 'approved-private-profile';
    fontInput.fontManifest = {
      format: 'news-writer-font-manifest',
      schemaVersion: 1,
      fonts: [
        {
          family: 'Private Fixture Font',
          fileName: '../private.ttf',
          version: '1',
          sha256: sha256Schema.parse(
            '0000000000000000000000000000000000000000000000000000000000000000',
          ),
          supplier: 'Private Fixture',
          licenseName: 'Restricted',
          redistributable: false,
          requiresAdministratorInstall: false,
          applicableStyles: ['body'],
        },
      ],
    };
    expect(() => buildInstitutionBundleV1(fontInput)).toThrow(/font|invalid/i);
  });
});
