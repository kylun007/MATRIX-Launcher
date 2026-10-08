import { cpus, totalmem, freemem, platform, release, arch } from 'node:os';
import { statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Settings } from '../../shared/contracts.ts';
import { hardwareOverrideSchema, type Hardware, type HardwareOverride, type Recommendation, type SmartPreferences, type SmartPreset } from '../../shared/smart.ts';
import { detectJava } from './java.ts';

const exec = promisify(execFile);
const GB = 1024 ** 3;
const windowsInfoSchema = z.object({
  cpus: z.array(z.object({ name: z.string(), cores: z.number().int().positive().nullable(), threads: z.number().int().positive().nullable() })),
  gpus: z.array(z.object({ name: z.string() })),
  os: z.string().nullable(), architecture: z.string().nullable(),
});
// Never interpolate a user path or command. AdapterRAM is deliberately excluded:
// Win32_VideoController exposes a uint32 that cannot reliably describe modern VRAM.
const WINDOWS_QUERY = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $c=@(Get-CimInstance Win32_Processor | ForEach-Object { @{name=$_.Name;cores=$_.NumberOfCores;threads=$_.NumberOfLogicalProcessors} }); $g=@(Get-CimInstance Win32_VideoController | ForEach-Object { @{name=$_.Name} }); $o=Get-CimInstance Win32_OperatingSystem; @{cpus=$c;gpus=$g;os=$o.Caption;architecture=$o.OSArchitecture} | ConvertTo-Json -Depth 5 -Compress`;

export function parseWindowsHardware(text: string): { cpu: Hardware['cpu']; gpus: Hardware['gpus']; os?: string; arch?: string } {
  const info = windowsInfoSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  const cores = info.cpus.every(c => c.cores !== null) && info.cpus.length ? info.cpus.reduce((n, c) => n + c.cores!, 0) : undefined;
  const threads = info.cpus.reduce((n, c) => n + (c.threads ?? 0), 0);
  const gpus = info.gpus.filter(g => g.name.trim()).map(g => {
    const name = g.name.trim();
    const integrated = /Intel.*(?:UHD|HD Graphics|Iris)|Radeon.*(?:Vega \d|Graphics$)/i.test(name) ? true
      : /NVIDIA.*(?:GeForce|RTX|GTX)|Radeon.*(?:RX\s*\d|Pro\s*\w)/i.test(name) ? false : undefined;
    return { name, ...(integrated !== undefined ? { integrated } : {}) };
  });
  return { cpu: { model: info.cpus.map(c => c.name.trim()).join(' / '), cores, threads }, gpus, os: info.os ?? undefined, arch: info.architecture ?? undefined };
}

export async function diskAvailable(path: string): Promise<number | undefined> {
  let candidate = resolve(path);
  for (;;) {
    try { const stats = await statfs(candidate, { bigint: true }); const bytes = stats.bavail * stats.bsize; return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : undefined; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
      const parent = dirname(candidate); if (parent === candidate) return undefined; candidate = parent;
    }
  }
}

export async function detectHardware(settings: Settings): Promise<Hardware> {
  const cpuList = cpus();
  const hardware: Hardware = {
    cpu: { model: cpuList[0]?.model ?? 'Processador não identificado', threads: cpuList.length, ...(cpuList[0]?.speed ? { mhz: cpuList[0].speed } : {}) },
    memory: { total: totalmem(), available: freemem() }, gpus: [],
    os: `${platform()} ${release()}`, arch: arch(), java: [], warnings: [],
  };
  const [space, java, windows] = await Promise.all([
    diskAvailable(settings.gameDirectory),
    detectJava(join(settings.gameDirectory, 'runtimes'), settings.javaPath).catch(() => undefined),
    platform() === 'win32' ? exec(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], { windowsHide: true, timeout: 30000, maxBuffer: 1_000_000, encoding: 'utf8' }).then(r => parseWindowsHardware(r.stdout)).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  hardware.diskAvailable = space;
  if (java) hardware.java = java;
  else hardware.warnings.push('Não foi possível concluir a busca de instalações Java. Selecione o executável manualmente.');
  if (windows) {
    hardware.cpu = { ...hardware.cpu, ...windows.cpu, model: windows.cpu.model || hardware.cpu.model, threads: windows.cpu.threads || hardware.cpu.threads };
    hardware.gpus = windows.gpus;
    if (windows.os) hardware.os = windows.os;
    if (windows.arch && /64/.test(windows.arch) && hardware.arch === 'ia32') hardware.warnings.push('O sistema é 64 bits, mas o launcher está executando em 32 bits.');
  }
  if (!hardware.cpu.cores) hardware.warnings.push('Quantidade de núcleos físicos indisponível. Você pode informá-la manualmente.');
  if (!hardware.gpus.length) hardware.warnings.push('Placa de vídeo não identificada. Informe a categoria manualmente para ajustar as recomendações.');
  else hardware.warnings.push('Memória de vídeo não disponível por uma fonte local confiável. Informe-a manualmente se desejar.');
  if (space === undefined) hardware.warnings.push('Espaço livre do diretório de instalação indisponível. Verifique o disco antes de instalar.');
  if (hardware.memory.total < 4 * GB) hardware.warnings.push('Há menos de 4 GB de RAM. Minecraft 1.21.1 pode não funcionar adequadamente mesmo com otimizações.');
  if (!['x64', 'arm64'].includes(hardware.arch)) hardware.warnings.push('Minecraft 1.21.1 exige um Java 64 bits; esta arquitetura precisa de verificação manual.');
  return hardware;
}

function effective(hardware: Hardware, overrides: HardwareOverride) {
  const o = hardwareOverrideSchema.parse(overrides);
  const memory = (o.memoryGB !== undefined ? o.memoryGB * GB : hardware.memory.total) / GB;
  const threads = o.cpuThreads ?? hardware.cpu.threads;
  // Missing physical cores stay unknown; logical threads are not treated as cores.
  const cores = o.cpuCores ?? hardware.cpu.cores;
  const dedicated = o.gpu !== undefined ? o.gpu === 'dedicated' : hardware.gpus.some(g => g.integrated === false);
  const knownGpu = o.gpu !== undefined ? o.gpu !== 'unknown' : hardware.gpus.some(g => g.integrated !== undefined);
  const vram = o.vramGB ?? Math.max(0, ...hardware.gpus.filter(g => g.integrated === false).map(g => (g.vram ?? 0) / GB));
  return { memory, threads, cores, dedicated, knownGpu, vram, manual: Object.keys(o).length > 0 };
}

export function presetPreferences(preset: SmartPreset, hardware: Hardware, overrides: HardwareOverride = {}): SmartPreferences {
  const h = effective(hardware, overrides);
  const totalMB = Math.floor(Math.min(h.memory * 1024, hardware.memory.total / 1024 ** 2));
  // Keep at least 2 GB (or 25%) for the OS; include currently available RAM
  // instead of allocating the whole nominal memory on a busy machine.
  const reserve = Math.max(2048, Math.ceil(totalMB * 0.25));
  const availableMB = Math.floor(hardware.memory.available / 1024 ** 2);
  const budget = Math.max(1024, Math.floor(Math.min(totalMB - reserve, availableMB - 768) / 256) * 256);
  const target = preset === 'performance' ? 3072 : preset === 'balanced' ? 4096 : 6144;
  const maxMemory = Math.min(target, budget, 65536);
  const constrained = h.memory < 8 || h.threads < 4 || (h.cores !== undefined && h.cores < 4);
  return {
    minMemory: Math.min(1024, maxMemory), maxMemory,
    renderDistance: preset === 'performance' ? 6 : preset === 'balanced' ? (constrained ? 8 : 10) : (constrained ? 10 : 16),
    simulationDistance: preset === 'ultra' && !constrained ? 8 : 5,
    particles: preset === 'performance' ? 'minimal' : preset === 'balanced' ? 'decreased' : 'all',
    graphics: preset === 'performance' ? 'fast' : 'fancy', maxFps: preset === 'performance' ? 120 : 60,
  };
}

export function recommendHardware(hardware: Hardware, overrides: HardwareOverride = {}): Recommendation {
  const h = effective(hardware, overrides);
  const low = h.memory < 8 || h.threads < 4 || (h.cores !== undefined && h.cores < 4) || hardware.memory.available < 3 * GB;
  const strong = h.memory >= 16 && h.threads >= 8 && h.cores !== undefined && h.cores >= 6 && h.dedicated && h.vram >= 6 && hardware.memory.available >= 6 * GB;
  const preset: SmartPreset = low || !h.knownGpu ? 'performance' : strong ? 'ultra' : 'balanced';
  const reasons = [
    'Recomendação estimada por CPU, RAM disponível e categoria de GPU; não garante uma taxa de FPS.',
    low ? 'Recursos de CPU ou memória limitados: priorizamos ajustes conservadores.' : strong ? 'CPU, memória e GPU informadas permitem oferecer gráficos mais altos.' : !h.knownGpu ? 'Sem informações confiáveis de GPU, priorizamos desempenho e mantemos shaders desativados.' : 'Os recursos informados favorecem um equilíbrio entre qualidade e consumo.',
  ];
  if (h.manual) reasons.push('Os valores manuais foram usados apenas na estimativa; a detecção original foi preservada.');
  if (!h.cores) reasons.push('Núcleos físicos desconhecidos: os threads não foram tratados como núcleos.');
  if (!h.vram) reasons.push('Sem VRAM confiável, shaders pesados não são recomendados automaticamente.');
  const shadersSuggested = !low && h.dedicated && h.vram >= 4;
  return { preset, preferences: presetPreferences(preset, hardware, overrides), reasons, shadersSuggested, estimated: true };
}
