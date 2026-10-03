import { useState } from 'react'
export function App() {
  const [count, setCount] = useState(0)
  return <main><h1>domino · webpack</h1><button onClick={() => setCount(value => value + 1)}>创建作品</button><p>已点击 {count} 次</p><p>悬停按钮，按 Space 或 Alt+Space 描述修改要求。</p></main>
}
