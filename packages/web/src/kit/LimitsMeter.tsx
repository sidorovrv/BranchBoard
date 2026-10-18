import { Fragment } from "react";
import { limitLevel, limitPercent, limitsTitle, limitWindowLabel, windowAt, type RateLimits } from "@branchboard/core";

interface LimitsMeterProps {
  limits: RateLimits;
  now: number;
}

export const LimitsMeter = ({ limits, now }: LimitsMeterProps) => {
  if (limits.windows.length === 0) return null;
  return (
    <span className="limits-meter" title={limitsTitle(limits, now)}>
      {limits.windows.map((original, index) => {
        const window = windowAt(original, now);
        return (
          <Fragment key={window.id}>
            {index > 0 && <span className="limit-separator">/</span>}
            <span className={`limit-value ${limitLevel(window.utilization)}`} aria-label={`${limitWindowLabel(window)}: ${limitPercent(window)}% used`}>
              {limitPercent(window)}%
            </span>
          </Fragment>
        );
      })}
    </span>
  );
};
