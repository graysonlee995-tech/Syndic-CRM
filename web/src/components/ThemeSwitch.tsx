import { ActionIcon, Card, SegmentedControl, Text, Title, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { IconMoon, IconSun } from '@tabler/icons-react';

/** Settings section: light, dark or follow the computer. Saved in this browser. */
export function AppearanceCard() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Card withBorder>
      <Title order={4} mb={4}>
        Appearance
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        Black and white theme. Your choice is remembered in this browser.
      </Text>
      <SegmentedControl
        value={colorScheme}
        onChange={(v) => setColorScheme(v as 'light' | 'dark' | 'auto')}
        data={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'auto', label: 'Match my computer' },
        ]}
      />
    </Card>
  );
}

/** Header button that flips between light and dark. */
export function ThemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const current = useComputedColorScheme('light');
  const next = current === 'dark' ? 'light' : 'dark';
  return (
    <Tooltip label={`Switch to ${next} mode`}>
      <ActionIcon variant="subtle" color="gray" size="lg" aria-label={`Switch to ${next} mode`} onClick={() => setColorScheme(next)}>
        {current === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}
