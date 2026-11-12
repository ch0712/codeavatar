// react-dom 的类型声明未随本仓库安装（运行时由宿主提供）。
// 只声明我们实际消费的这一个 API，避免为了类型新增依赖。
declare module 'react-dom/server' {
  import type { ReactNode } from 'react';
  export function renderToStaticMarkup(element: ReactNode): string;
}
