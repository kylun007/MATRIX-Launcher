import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentCatalog } from '../electron/services/catalog.ts';

const project = (id: string, kind = 'mod') => ({ id, slug: id, title: id, description: 'Published project', project_type: kind,
  status: 'approved', client_side: 'required', license: { id: 'MIT', name: 'MIT License', url: null }, icon_url: 'https://cdn.modrinth.com/icon.png', gallery: [] });
const version = (projectId: string, id: string, dependencies: unknown[] = [], overrides: object = {}) => ({
  id, project_id: projectId, version_number: '1.0.0', version_type: 'release', status: 'listed',
  date_published: '2026-01-01T00:00:00Z', game_versions: ['1.21.1'], loaders: ['fabric'], dependencies,
  files: [{ filename: `${projectId}.jar`, primary: true, size: 256, hashes: { sha512: 'a'.repeat(128), sha1: 'b'.repeat(40) } as Record<string, string>, url: `https://cdn.modrinth.com/data/${projectId}/versions/${id}/${projectId}.jar` }], ...overrides,
});
const dep = (projectId: string | null, versionId: string | null = null, dependencyType = 'required') => ({ project_id: projectId, version_id: versionId, file_name: null, dependency_type: dependencyType });
function fixture(projects: ReturnType<typeof project>[], versions: ReturnType<typeof version>[]) {
  const requests: string[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); requests.push(url.href);
    assert.match(new Headers(init?.headers).get('User-Agent')!, /MATRIXLauncher/); assert.equal(init?.redirect, 'manual');
    const path = url.pathname;
    if (path.includes('/versions/loader/')) return Response.json([{ loader: { version: '0.99.0', stable: false } }, { loader: { version: '0.98.1', stable: true } }]);
    if (path === '/v2/search') return Response.json({ hits: projects.filter(p => p.project_type === 'shader').map(p => ({ project_id: p.id })) });
    const segments = path.split('/'); const id = segments[3];
    if (segments[2] === 'version') return Response.json(versions.find(v => v.id === id));
    if (segments[4] === 'version') return Response.json(versions.filter(v => v.project_id === id));
    const p = projects.find(p => p.id === id); return p ? Response.json(p) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { catalog: new ContentCatalog(fetcher), requests };
}

test('Fabric uses real stable metadata and required dependencies are recursively resolved', async () => {
  const { catalog, requests } = fixture([project('sodium'), project('lithium'), project('fabric-api')], [
    version('sodium', 'SodiumV', [dep('fabric-api')]), version('lithium', 'LithiumV', [dep('fabric-api'), dep('optional', null, 'optional')]), version('fabric-api', 'ApiV'),
  ]);
  assert.equal(await catalog.fabric(), '0.98.1');
  const files = await catalog.resolveMods(['sodium', 'lithium']);
  assert.deepEqual(files.map(f => f.projectId).sort(), ['fabric-api', 'lithium', 'sodium']);
  assert.ok(files.every(f => f.algorithm === 'sha512')); assert.ok(!requests.some(r => r.includes('/optional')));
});

test('Iris exact Sodium dependency backtracks to a compatible release and terminates dependency cycles', async () => {
  const { catalog } = fixture([project('sodium'), project('iris')], [
    version('sodium', 'NewSodium', [], { date_published: '2026-02-01T00:00:00Z' }),
    version('sodium', 'OldSodium', [dep('iris')]), version('iris', 'IrisV', [dep('sodium', 'OldSodium')]),
  ]);
  const files = await catalog.resolveMods(['sodium', 'iris']);
  assert.equal(files.find(f => f.projectId === 'sodium')!.versionId, 'OldSodium'); assert.equal(files.length, 2);
});

test('rejected internal-metadata versions select older releases and backtrack exact dependency pins', async () => {
  const { catalog } = fixture([project('sodium'), project('iris')], [
    version('sodium', 'NewSodium', [], { date_published: '2026-02-01T00:00:00Z' }), version('sodium', 'OldSodium'),
    version('iris', 'NewIris', [dep('sodium', 'NewSodium')], { date_published: '2026-02-01T00:00:00Z' }),
    version('iris', 'OldIris', [dep('sodium', 'OldSodium')]),
  ]);
  const files = await catalog.resolveMods(['sodium', 'iris'], undefined, new Set(['NewSodium']));
  assert.equal(files.find(f => f.projectId === 'sodium')!.versionId, 'OldSodium');
  assert.equal(files.find(f => f.projectId === 'iris')!.versionId, 'OldIris');
  await assert.rejects(catalog.resolveMods(['sodium'], undefined, new Set(['NewSodium', 'OldSodium'])), /combinação compatível/);
});

test('declared incompatibilities, external dependencies and wrong game/loaders fail closed', async () => {
  let f = fixture([project('sodium'), project('lithium')], [version('sodium', 'SodiumV'), version('lithium', 'LithiumV', [dep('sodium', null, 'incompatible')])]);
  await assert.rejects(f.catalog.resolveMods(['sodium', 'lithium']), /incompatibilidade/);
  f = fixture([project('sodium')], [version('sodium', 'SodiumV', [dep(null)])]);
  await assert.rejects(f.catalog.resolveMods(['sodium']), /dependência externa/);
  f = fixture([project('sodium')], [version('sodium', 'SodiumV', [], { loaders: ['forge'] })]);
  await assert.rejects(f.catalog.resolveMods(['sodium']), /combinação compatível/);
});

test('publisher CDN, filenames and hashes are validated before installation', async () => {
  for (const unsafe of [
    { filename: '../evil.jar' }, { filename: 'CON.jar' }, { url: 'https://evil.example/payload.jar' },
    { url: 'https://cdn.modrinth.com/data/another/versions/Bad/file.jar' }, { hashes: {} },
  ]) {
    const v = version('sodium', 'SodiumV'); v.files[0] = { ...v.files[0], ...unsafe };
    const { catalog } = fixture([project('sodium')], [v]);
    await assert.rejects(catalog.resolveMods(['sodium']));
  }
});

test('shader search accepts licensed direct downloads and excludes incompatible/unverified projects', async () => {
  const p = project('bsl-shaders', 'shader'); p.license = { id: 'LicenseRef-All-Rights-Reserved', name: '', url: null };
  const v = version(p.id, 'ShaderV', [], { loaders: ['iris', 'optifine'] });
  v.files[0] = { ...v.files[0], filename: 'BSL.zip', url: `https://cdn.modrinth.com/data/${p.id}/versions/ShaderV/BSL.zip` };
  const { catalog } = fixture([p, project('unsupported', 'shader')], [v, version('unsupported', 'OtherV', [], { loaders: ['optifine'] })]);
  const shaders = await catalog.searchShaders('BSL'); assert.equal(shaders.length, 1); assert.equal(shaders[0].license, 'LicenseRef-All-Rights-Reserved');
  const file = await catalog.resolveShader(p.id); assert.equal(file.kind, 'shader'); assert.equal(file.filename, 'BSL.zip');
});

test('catalog records unavailable candidates honestly and abort does not become unavailable content', async () => {
  const { catalog } = fixture([project('sodium'), project('modernfix')], [version('sodium', 'SodiumV')]);
  const candidates = await catalog.catalog(); assert.equal(candidates.length, 8);
  assert.equal(candidates.find(p => p.slug === 'sodium')!.available, true);
  assert.equal(candidates.find(p => p.slug === 'modernfix')!.available, false);
  const controller = new AbortController(); controller.abort(); await assert.rejects(catalog.catalog(controller.signal), { name: 'AbortError' });
});

test('Mod Center search facets follow the selected instance and projects resolve for its loader and game version', async () => {
  let requested: URL | undefined;
  const searchFetch = (async (input, init) => {
    requested = new URL(String(input)); assert.equal(init?.redirect, 'manual');
    return Response.json({ offset: 12, limit: 12, total_hits: 1, hits: [{ project_id: 'samplemod', slug: 'samplemod', title: 'Sample Mod', description: 'Real catalog result', author: 'Creator', downloads: 42_000, categories: ['forge', 'technology'], versions: ['1.20.1'], license: 'MIT', icon_url: null, gallery: [] }] });
  }) as typeof fetch;
  const catalog = new ContentCatalog(searchFetch);
  const page = await catalog.searchMods({ query: 'sample', type: 'mod', minecraft: '1.20.1', loader: 'forge', compatibleOnly: true, index: 'downloads', offset: 12, limit: 12 });
  assert.equal(page.projects[0].compatible, true); assert.equal(page.projects[0].author, 'Creator'); assert.equal(page.total, 1);
  assert.deepEqual(JSON.parse(requested!.searchParams.get('facets')!), [['project_type:mod'], ['versions:1.20.1'], ['categories:forge']]);

  const sample = project('samplemod'); const forge = version('samplemod', 'ForgeVersion', [], { game_versions: ['1.20.1'], loaders: ['forge'] });
  const fixtureCatalog = fixture([sample], [forge]).catalog;
  const files = await fixtureCatalog.resolveProject('samplemod', '1.20.1', 'forge');
  assert.equal(files.length, 1); assert.equal(files[0].versionId, 'ForgeVersion');
});
