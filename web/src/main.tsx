import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import {
  MantineProvider,
  alpha,
  createTheme,
  defaultVariantColorsResolver,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type VariantColorsResolver,
} from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/dropzone/styles.css';
import { queryClient } from './api';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * Black and white: the accent is black in light mode and white in dark mode
 * (shade 0 = white ... 9 = black). Red is kept for alerts and warnings only.
 */
const mono: MantineColorsTuple = [
  '#ffffff',
  '#f1f3f5',
  '#e9ecef',
  '#dee2e6',
  '#ced4da',
  '#adb5bd',
  '#6c757d',
  '#343a40',
  '#212529',
  '#000000',
];

/**
 * Mantine's light / subtle / outline variants tint with the accent itself, which
 * for white (dark mode) gives white text on a pale background. Use the theme's
 * neutral surfaces and text color instead, so they read well in both modes.
 */
const variantColorResolver: VariantColorsResolver = (input) => {
  const color = input.color ?? input.theme.primaryColor;
  // The black / white shades are for the accent only; alert colors (red, orange, ...) use Mantine's usual shades.
  if (color !== 'mono') return defaultVariantColorsResolver({ ...input, theme: { ...input.theme, primaryShade: { light: 6, dark: 8 } } });
  const base = defaultVariantColorsResolver(input);
  if (input.variant === 'filled') {
    // Black button with white text in light mode, white button with dark text in dark mode.
    return { ...base, color: 'var(--mantine-color-body)' };
  }
  if (input.variant === 'light') {
    return {
      ...base,
      background: 'var(--mantine-color-default-hover)',
      hover: 'var(--mantine-color-default-border)',
      color: 'var(--mantine-color-text)',
      border: 'none',
    };
  }
  if (input.variant === 'subtle') {
    return { ...base, background: 'transparent', hover: 'var(--mantine-color-default-hover)', color: 'var(--mantine-color-text)' };
  }
  if (input.variant === 'outline') {
    return { ...base, background: 'transparent', hover: 'var(--mantine-color-default-hover)', color: 'var(--mantine-color-text)', border: '1px solid var(--mantine-color-text)' };
  }
  return base;
};

/**
 * Alert colors (red, orange, green, ...) at their usual strength in both modes;
 * without this they would follow the accent's white-in-dark-mode shade and turn
 * pale. In dark mode text is white, and so is text on tinted (light) buttons
 * and badges.
 */
const cssVariablesResolver: CSSVariablesResolver = (t) => {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = { '--mantine-color-text': '#ffffff', '--mantine-color-bright': '#ffffff' };
  for (const [name, c] of Object.entries(t.colors)) {
    if (name === 'mono' || name === 'dark') continue;
    Object.assign(light, {
      [`--mantine-color-${name}-filled`]: c[7],
      [`--mantine-color-${name}-filled-hover`]: c[8],
      [`--mantine-color-${name}-light`]: alpha(c[6], 0.1),
      [`--mantine-color-${name}-light-hover`]: alpha(c[6], 0.16),
      [`--mantine-color-${name}-light-color`]: c[8],
      [`--mantine-color-${name}-outline`]: c[7],
      [`--mantine-color-${name}-outline-hover`]: alpha(c[7], 0.06),
      [`--mantine-color-${name}-text`]: c[7],
    });
    Object.assign(dark, {
      [`--mantine-color-${name}-filled`]: c[8],
      [`--mantine-color-${name}-filled-hover`]: c[9],
      [`--mantine-color-${name}-light`]: alpha(c[7], 0.35),
      [`--mantine-color-${name}-light-hover`]: alpha(c[7], 0.45),
      [`--mantine-color-${name}-light-color`]: '#ffffff',
      [`--mantine-color-${name}-outline`]: c[4],
      [`--mantine-color-${name}-outline-hover`]: alpha(c[4], 0.1),
      [`--mantine-color-${name}-text`]: c[4],
    });
  }
  return { variables: {}, light, dark };
};

const theme = createTheme({
  colors: { mono },
  primaryColor: 'mono',
  primaryShade: { light: 9, dark: 0 },
  autoContrast: true,
  variantColorResolver,
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="auto">
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
);
