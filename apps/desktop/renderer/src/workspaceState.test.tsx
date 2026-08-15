import { describe, expect, it } from 'vitest';

import type { ProjectViewDto } from '@news-writer/shared/ipc';

import {
  createWorkspaceState,
  isAnchorValid,
  makeTextSelection,
  projectVersions,
  workspaceReducer,
} from './workspaceState';

const makeView = (): ProjectViewDto =>
  ({
    sessionId: '20000000-0000-4000-8000-000000000001',
    revision: 1,
    projectId: '20000000-0000-4000-8000-000000000002',
    name: '分支项目',
    profile: 'official',
    status: 'active',
    createdAt: '2026-08-10T00:00:00.000000Z',
    updatedAt: '2026-08-10T00:00:00.000000Z',
    latestVersionId: '20000000-0000-4000-8000-000000000012',
    projectConfig: {},
    minutes: {
      minuteId: '20000000-0000-4000-8000-000000000003',
      revisionId: '20000000-0000-4000-8000-000000000004',
      createdAt: '2026-08-10T00:00:00.000000Z',
      content: '原纪要',
    },
    versions: [
      {
        id: '20000000-0000-4000-8000-000000000010',
        createdAt: '2026-08-10T00:00:01.000000Z',
        parentVersionId: null,
        createdBy: 'draftGeneration',
        taskId: '20000000-0000-4000-8000-000000000020',
        contentSha256: 'a'.repeat(64),
        content: '根',
      },
      {
        id: '20000000-0000-4000-8000-000000000011',
        createdAt: '2026-08-10T00:00:02.000000Z',
        parentVersionId: '20000000-0000-4000-8000-000000000010',
        createdBy: 'aiReview',
        taskId: '20000000-0000-4000-8000-000000000021',
        contentSha256: 'b'.repeat(64),
        content: '旧分支',
      },
      {
        id: '20000000-0000-4000-8000-000000000012',
        createdAt: '2026-08-10T00:00:03.000000Z',
        parentVersionId: '20000000-0000-4000-8000-000000000010',
        createdBy: 'commentRevision',
        taskId: '20000000-0000-4000-8000-000000000022',
        contentSha256: 'c'.repeat(64),
        content: '当前分支',
      },
    ],
    comments: [],
    prompts: [],
    tasks: [],
    retrievalReports: [],
    images: [],
  }) as unknown as ProjectViewDto;

describe('workspace reducer and projections', () => {
  it('preserves a dirty minutes draft across a conflict refresh', () => {
    let state = createWorkspaceState(makeView());
    state = workspaceReducer(state, { type: 'editMinutes', value: '本地草稿' });
    const refreshed = {
      ...makeView(),
      revision: 2,
      minutes: { ...makeView().minutes, content: '磁盘新内容' },
    };
    state = workspaceReducer(state, { type: 'replaceView', view: refreshed });
    expect(state.minutes.value).toBe('本地草稿');
    expect(state.minutes.dirty).toBe(true);
    expect(state.view.revision).toBe(2);
  });

  it('moves the selected version to a newly generated latest version', () => {
    let state = createWorkspaceState(makeView());
    state = workspaceReducer(state, {
      type: 'selectVersion',
      versionId: makeView().versions[0]!.id,
    });
    state = workspaceReducer(state, { type: 'setDiff', enabled: true });
    const nextVersion = {
      id: '20000000-0000-4000-8000-000000000013',
      createdAt: '2026-08-10T00:00:04.000000Z',
      parentVersionId: makeView().latestVersionId,
      createdBy: 'commentRevision' as const,
      taskId: '20000000-0000-4000-8000-000000000023',
      contentSha256: 'd'.repeat(64),
      content: '新版本',
    } as ProjectViewDto['versions'][number];
    state = workspaceReducer(state, {
      type: 'replaceView',
      view: {
        ...makeView(),
        revision: 2,
        latestVersionId: nextVersion.id,
        versions: [...makeView().versions, nextVersion],
      },
    });
    expect(state.selectedVersionId).toBe(nextVersion.id);
    expect(state.diffMode).toBe(false);
  });

  it('keeps a historical selection when a refresh does not change latest', () => {
    let state = createWorkspaceState(makeView());
    const historicalId = makeView().versions[0]!.id;
    state = workspaceReducer(state, { type: 'selectVersion', versionId: historicalId });
    state = workspaceReducer(state, { type: 'replaceView', view: { ...makeView(), revision: 2 } });
    expect(state.selectedVersionId).toBe(historicalId);
  });

  it('projects latest ancestry separately from later-created branches', () => {
    const nodes = projectVersions(makeView());
    expect(nodes.find((node) => node.id.endsWith('11'))?.isBranch).toBe(true);
    expect(nodes.find((node) => node.id.endsWith('12'))?.isLatest).toBe(true);
    expect(nodes.filter((node) => node.onCurrentChain)).toHaveLength(2);
  });

  it('uses UTF-16 offsets and validates exact anchors without fuzzy rebinding', () => {
    const content = '甲😀乙，活动顺利举行。';
    const selection = makeTextSelection(content, 1, 4);
    expect(selection?.exact).toBe('😀乙');
    expect(
      isAnchorValid(content, 'd'.repeat(64), { contentSha256: 'd'.repeat(64), ...selection! }),
    ).toBe(true);
    expect(
      isAnchorValid(content.replace('乙', '丙'), 'd'.repeat(64), {
        contentSha256: 'd'.repeat(64),
        ...selection!,
      }),
    ).toBe(false);
  });
});
