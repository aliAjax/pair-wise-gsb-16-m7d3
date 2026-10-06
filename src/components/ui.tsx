import React from "react";

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "danger" | "info";
  children: React.ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({
  title,
  extra,
  children,
  className = "",
}: {
  title?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title !== undefined && (
        <div className="section-heading">
          <h2>{title}</h2>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="empty-hint">{text}</p>;
}

export function fmtDateTime(t: number): string {
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

export function shortTime(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}
