export function TextField({
  label,
  value,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  maxLength?: number;
  onChange: (v: string) => void;
}) {
  return (
    <label className="studio-field">
      {label}
      <input maxLength={maxLength} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="studio-field">
      {label}
      <input
        type="number"
        step="any"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
export function VectorField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
  min?: number;
  max?: number;
}) {
  return (
    <fieldset className="studio-vector">
      <legend>{label}</legend>
      {['X', 'Y', 'Z'].map((axis, i) => (
        <label key={axis}>
          {axis}
          <input
            aria-label={`${label} ${axis}`}
            type="number"
            step="any"
            min={min}
            max={max}
            value={value[i]}
            onChange={(e) => {
              const next = [...value] as [number, number, number];
              next[i] = Number(e.target.value);
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}
