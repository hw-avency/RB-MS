type ParkingTransitionIndicatorProps = {
  text?: string;
};

export function ParkingTransitionIndicator({ text }: ParkingTransitionIndicatorProps) {
  return (
    <div className="parking-transition" role="note" aria-label={text ?? 'Reihenfolge der Buchung'}>
      <span className="parking-transition-line" aria-hidden="true" />
      <span className="parking-transition-arrow" aria-hidden="true">→</span>
      {text ? <span className="parking-transition-text">{text}</span> : null}
    </div>
  );
}
