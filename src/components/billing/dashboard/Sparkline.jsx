import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { SERIES } from "../../crm/progress/progressText";

const MUTED = "#94a3b8";

function LastDot({ cx, cy, index, points }) {
  if (index !== points - 1 || cx === undefined) return null;
  return <circle cx={cx} cy={cy} r={3} fill={SERIES[0]} stroke="#fff" strokeWidth={1.5} />;
}

export default function Sparkline({ values }) {
  if (!values || values.length < 3) return null;
  const rows = values.map((value, index) => ({ index, value }));
  return (
    <div className="bdash-spark" aria-hidden="true">
      <ResponsiveContainer width="100%" height={32}>
        <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            dataKey="value"
            stroke={MUTED}
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={(props) => <LastDot key={props.index} {...props} points={rows.length} />}
            activeDot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
