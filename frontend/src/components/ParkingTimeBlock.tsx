type ParkingTimeBlockProps = {
  number: string;
  startTime: string;
  endTime: string;
  hasCharging: boolean;
  hint?: string;
};

export function ParkingTimeBlock({ number, startTime, endTime, hasCharging, hint }: ParkingTimeBlockProps) {
  return (
    <article className="parking-time-block" aria-label={`Parkplatz ${number} von ${startTime} bis ${endTime}`}>
      <div className="parking-time-block-header">
        <div className="parking-time-block-number" aria-hidden="true">{number}</div>
        <div className="parking-time-block-meta">
          {hasCharging ? (
            <p className="parking-time-block-charging"><span aria-hidden="true">⚡</span> E-Ladeplatz</p>
          ) : (
            <p className="parking-time-block-standard">Parkplatz</p>
          )}
        </div>
      </div>
      <p className="parking-time-block-time">{startTime} – {endTime}</p>
      {hint && <p className="parking-time-block-hint">{hint}</p>}
    </article>
  );
}

