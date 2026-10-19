import React from 'react';
export class StudioBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main style={{ padding: 40, color: '#dbeafe', fontFamily: 'system-ui', maxWidth: 700 }}>
        <h1>VoxShop could not open this workspace</h1>
        <p>{this.state.error}</p>
        <p>
          Use a desktop browser with WebGL2 enabled. Saved project files remain in the local .voxshop
          directory.
        </p>
        <button onClick={() => location.reload()}>Reload workspace</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
