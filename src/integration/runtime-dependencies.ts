import { DominoError } from '../core/types'

export async function assertRuntimeDependencies(resolve: (dependency: string) => Promise<boolean>) {
  for (const dependency of ['react', 'react/jsx-runtime', 'react-dom/client']) {
    if (!await resolve(dependency)) throw new DominoError('RUNTIME_DEPENDENCY_MISSING', 'Domino 面板需要 React 19 和 React DOM 19，请安装：npm install react@^19 react-dom@^19')
  }
}
