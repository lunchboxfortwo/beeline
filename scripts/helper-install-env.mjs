// ACP receives a complete child environment, not a merge with its parent.
// Keep installed-helper acceptance inside the installation probe's lab homes.
export function helperInstallAgentEnv(env) {
  return {
    HOME: env.HOME,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME,
    BEELINE_LAB: '1',
    PATH: env.PATH ?? '',
    BUZZ_AGENT_PROVIDER: 'openai',
    OPENAI_COMPAT_API_KEY: 'install-probe',
    OPENAI_COMPAT_MODEL: 'install-probe',
    OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:1/v1',
  };
}
