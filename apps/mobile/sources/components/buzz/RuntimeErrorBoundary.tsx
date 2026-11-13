import * as React from 'react';
import { Platform, Appearance } from 'react-native';
import { ScrollView, TamaguiProvider, YStack } from 'tamagui';
import { Btn, T } from '@/ui/grammar';
import { tamaguiConfig, themeName } from '@/ui/tamagui.config';
import { reportClientError, type ClientErrorScope } from '@/buzz/client-error-report';
import { storage } from '@/sync/storage';
import { resolveAppAppearance } from '@/buzz/app-appearance-seed';
import { checkNativeUpdate, reloadNativeUpdate } from '@/hooks/useUpdates';

/**
 * No navigation, modal or safe-area hooks. The root screen draws outside the
 * app's GrammarProvider, so it mounts the grammar theme itself from Appearance.
 */
export function RuntimeErrorView({ error, retry, scope }: {
  error: unknown; retry(): void; scope: ClientErrorScope;
}) {
  React.useEffect(() => { void reportClientError(scope, error); }, [scope, error]);
  React.useEffect(() => {
    if (scope !== 'app' || Platform.OS === 'web') return;
    // The root boundary replaces UpdateProvider, so recovery owns one check here.
    void checkNativeUpdate().then(async (update) => {
      if (update.available) await reloadNativeUpdate();
    }).catch(() => { /* Keep the original error and Retry available. */ });
  }, [scope]);
  const explanation = scope === 'app' ? 'Beeline could not display this screen' : 'Conversation mode could not start';
  const body = (
    <YStack backgroundColor="canvas" padding="4" gap="2" testID="runtime-error">
      <T v="heading" accessibilityRole="alert">
        {scope === 'app' ? 'Beeline could not display this screen' : 'Conversation mode could not start'}
      </T>
      <ScrollView maxHeight={256}>
        <T userSelect="text" testID="runtime-error-message">{explanation}</T>
      </ScrollView>
      <YStack alignSelf="flex-start">
        <Btn kind="quiet" label="Retry" onPress={retry} testID="runtime-error-retry">
          <T v="heading" color="needsYou">Retry</T>
        </Btn>
      </YStack>
    </YStack>
  );
  if (scope !== 'app') return body;
  const settings = storage.getState().localSettings;
  const mode = resolveAppAppearance(settings.appearance, Appearance.getColorScheme());
  return (
    <TamaguiProvider config={tamaguiConfig} defaultTheme={themeName(mode, settings.palette)}>
      <YStack flex={1} backgroundColor="canvas" paddingTop="8">{body}</YStack>
    </TamaguiProvider>
  );
}

export class RuntimeErrorBoundary extends React.Component<{
  children: React.ReactNode; scope: ClientErrorScope; onError?(): void | Promise<void>; onRetry?(): void | Promise<void>;
}, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch() {
    try { void Promise.resolve(this.props.onError?.()).catch(() => {}); } catch { /* Recovery remains visible. */ }
  }
  private retry = () => {
    this.setState({ error: null });
    try { void Promise.resolve(this.props.onRetry?.()).catch(cause => this.setState({ error: cause instanceof Error ? cause : new Error(String(cause)) })); }
    catch (cause) { this.setState({ error: cause instanceof Error ? cause : new Error(String(cause)) }); }
  };
  render() {
    return this.state.error ? <RuntimeErrorView error={this.state.error} retry={this.retry} scope={this.props.scope} /> : this.props.children;
  }
}
