import { Component, type ReactNode } from "react";

/** An optional editor failure must never take the running terminal UI down. */
export default class IdeBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="harbor-ide-loading" role="alert">
        편집기를 열지 못했습니다. 아래 터미널은 계속 사용할 수 있습니다.
        <br />
        {this.state.error}
      </div>
    ) : (
      this.props.children
    );
  }
}
