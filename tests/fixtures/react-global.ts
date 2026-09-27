import * as React from 'react';

/**
 * The app's components are written for Next's JSX transform; vitest compiles
 * their JSX to the classic `React.createElement`, which reads a global
 * `React`. Some modules build elements AT IMPORT (the icon set's path table),
 * so the global must exist before they are evaluated — which is why this is
 * its own module, imported FIRST by a test that renders components, rather
 * than a line in the test file that runs after every import has already been
 * evaluated.
 */
(globalThis as { React?: typeof React }).React = React;
