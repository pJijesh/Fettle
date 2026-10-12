export function PublicShell({ clinicName, children, wide }: { clinicName: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <>
      <header className="top">
        <div className="in" style={{ maxWidth: 720 }}>
          <span className="brand" style={{ fontWeight: 700 }}>{clinicName}</span>
        </div>
      </header>
      <main style={{ maxWidth: wide ? 820 : 640 }}>{children}</main>
    </>
  );
}
