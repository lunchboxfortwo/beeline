// Per-job command adapters keep Docker's build containers in the same existing
// resource slice as their release worker. No daemon configuration is changed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function localToolPlan(tool, args, config) {
  const docker = values => {
    const position = ['build', 'run', 'create'].includes(values[0]) ? 1
      : ['image', 'container'].includes(values[0]) && ['build', 'run', 'create'].includes(values[1]) ? 2 : 0;
    if (!position) return values;
    if (values.some(value => value.startsWith('--cgroup-parent'))) throw new Error('Local Docker parent is owned by the release worker');
    return [...values.slice(0, position), `--cgroup-parent=${config.slice}`, ...values.slice(position)];
  };
  if (tool === 'docker') return [{ command: config.docker, args: docker(args), legacy: true }];
  if (tool !== 'flyctl') throw new Error(`Unsupported local release tool: ${tool}`);
  if (!(args[0] === 'deploy' && args.includes('--local-only') && args.includes('--build-only'))) return [{ command: config.flyctl, args }];
  const values = { buildArgs: [] };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (['--local-only', '--build-only', '--push', '--yes'].includes(arg) || arg === '.') continue;
    if (!['--app', '--dockerfile', '--image-label', '--config', '--build-arg'].includes(arg) || !args[i + 1]) throw new Error(`Unsupported local Fly build option: ${arg}`);
    const value = args[++i];
    if (arg === '--build-arg') values.buildArgs.push('--build-arg', value);
    else values[arg.slice(2)] = value;
  }
  const files = { 'beeline-server': 'apps/server/Dockerfile', 'beeline-free-agents': 'infra/free-agent/Dockerfile' };
  if (files[values.app] !== values.dockerfile || !values['image-label'] || !args.includes('--push')) throw new Error('Local Fly build requires the known image, explicit Dockerfile, label and push');
  const image = `registry.fly.io/${values.app}:${values['image-label']}`;
  return [
    { command: config.flyctl, args: ['auth', 'docker'] },
    { command: config.docker, args: docker(['build', '--file', values.dockerfile, '--tag', image, ...values.buildArgs, '.']), legacy: true },
    { command: config.docker, args: ['push', image] },
  ];
}

/** @public Per-job executable shims load this entry by file URL. */
export function runLocalTool(tool, args) {
  const config = JSON.parse(readFileSync(process.env.BEELINE_LOCAL_RELEASE_TOOL_CONFIG, 'utf8'));
  for (const call of localToolPlan(tool, args, config)) {
    const result = spawnSync(call.command, call.args, { stdio: 'inherit', env: { ...process.env, ...(call.legacy ? { DOCKER_BUILDKIT: '0' } : {}) } });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
