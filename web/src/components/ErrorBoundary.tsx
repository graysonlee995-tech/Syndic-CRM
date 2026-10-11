import { Component, type ReactNode } from 'react';
import { Alert, Button, Code, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

interface State {
  error: Error | null;
}

/**
 * Catches errors while rendering a page so the app shows what went wrong
 * instead of going blank. Give it a `key` that changes on navigation so
 * moving to another page clears the error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Page crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert color="red" variant="light" icon={<IconAlertTriangle />} title="This page hit an error" maw={800}>
        <Stack gap="sm">
          <Text size="sm">
            Nothing was lost. Reload the page to try again, or use the menu to go to another page. If it keeps happening,
            send this message to your developer:
          </Text>
          <Code block>{error.message || String(error)}</Code>
          <Group>
            <Button size="xs" onClick={() => window.location.reload()}>
              Reload page
            </Button>
            <Button size="xs" variant="default" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }
}
