import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <main>
      <div className="eyebrow">DOMINO / LOCAL DEVELOPMENT</div>
      <h1>
        从页面开始，
        <br />
        修改你的代码。
      </h1>
      <p className="intro">打开右下角 domino，选择一个元素，描述你想要的变化。</p>
      <section className="card">
        <div className="card-label">试试这个按钮</div>
        <h2>把想法变成真实改动</h2>
        <p>例如：“把按钮改成紫色，增大圆角，并修改按钮文字。”</p>
        <button className="create-button" onClick={() => setCount(count + 1)}>
          The Create
        </button>
        <span className="counter">已点击 {count} 次</span>
      </section>
      <div className="features">
        <div>
          <strong>源码定位</strong>
          <p>编译期标记与版本校验</p>
        </div>
        <div>
          <strong>真实 diff</strong>
          <p>核对每次文件修改</p>
        </div>
        <div>
          <strong>受控撤销</strong>
          <p>保留已有未提交内容</p>
        </div>
      </div>
    </main>
  )
}
