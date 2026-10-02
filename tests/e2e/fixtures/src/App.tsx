import { useState } from 'react'
export function App() {
  const [count, setCount] = useState(0)
  return <main>
    <h1>domino 浏览器测试</h1>
    <button className="create-button" onClick={() => setCount(value => value + 1)}>创建作品</button>
    <span className="counter">已点击 {count} 次</span>
  </main>
}
