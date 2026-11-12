using System;
using System.Collections.Generic;
using Unity.Mathematics;

namespace CS2MCP
{
    /// <summary>Where a planned ramp end meets an existing road: the point on its centreline and the travel direction there.</summary>
    public struct RoadHit
    {
        public bool Found;
        public float2 Position;
        /// <summary>Unit travel direction of the carriageway at Position, in the sense that was asked for.</summary>
        public float2 Direction;
        public bool TwoWay;
        /// <summary>Height of the road above the terrain at Position (bridges &gt; 0, cuttings/tunnels &lt; 0).</summary>
        public float Elevation;
    }

    public enum RoadRole
    {
        Major,
        Minor,
    }

    /// <summary>Finds the carriageway of a road that carries travelDir nearest to guess (anyDirection: either way).</summary>
    public delegate RoadHit RoadProjector(RoadRole role, float2 guess, float2 travelDir, bool anyDirection);

    /// <summary>One segment to build: a straight line, a quadratic (C1) or a cubic (C1 + C2) between two points.</summary>
    public sealed class RampSegment
    {
        public float2 Start;
        public float2 End;
        public bool HasC1;
        public float2 C1;
        public bool HasC2;
        public float2 C2;
        /// <summary>Elevation above terrain at each end (free ends are built at it; joined ends only join roads at it).</summary>
        public float E1;
        public float E2;
        /// <summary>True for the two-way stem of a trumpet, built with the minor road's own prefab instead of the ramp prefab.</summary>
        public bool UseMinorPrefab;
        public float Length;
    }

    /// <summary>One movement of the interchange (e.g. the loop from northbound to westbound), as a chain of segments.</summary>
    public sealed class Ramp
    {
        public string Name;
        public string Kind;
        public readonly List<RampSegment> Segments = new List<RampSegment>();
        /// <summary>Whether the first / last point must join an existing road (checked after building).</summary>
        public bool JoinsStart;
        public bool JoinsEnd;
        public float Length;
        public float Rise;
        public float Grade;
    }

    public sealed class InterchangeSite
    {
        /// <summary>Where the two roads cross (trumpet: where the stem axis meets the middle of the through road).</summary>
        public float2 Center;
        public float2 MajorDir;
        public float2 MinorDir;
        public bool LeftHandTraffic;
        // Trumpet only: the dead end the stem grows from, and the distance from it to Center.
        public float2 StemStart;
        public float StemElevation;
    }

    public sealed class InterchangeOptions
    {
        public string Type;
        /// <summary>parclo: "A" (loops are on-ramps ahead of the crossing, Ontario A4) or "B" (loops are off-ramps beyond it).</summary>
        public string Variant = "A";
        public float Radius;
        public float RampLength;
        public float TerminalOffset;
        public float Clearance;
    }

    public sealed class PlanException : Exception
    {
        public PlanException(string message) : base(message)
        {
        }
    }

    /// <summary>
    /// Pure geometry for interchange layouts. Works in the XZ plane on straight-line
    /// models of the two roads near the crossing, then projects every ramp terminal
    /// onto the real carriageway through the RoadProjector, so dual one-way
    /// carriageways and single two-way roads are handled alike. Design values follow
    /// highway practice: loop radius from the AASHTO minimum-radius formula
    /// R = V^2 / (127 (e + f)), ramp grades held to 8 % (6 % preferred), and
    /// ramp-terminal spacing in the range used for diamond and parclo interchanges.
    /// </summary>
    public static class InterchangePlanner
    {
        public const float MaxGrade = 0.08f;
        public const float PreferredGrade = 0.06f;
        private const float PieceAngle = math.PI / 4f;
        // Clear distance kept between the centrelines of a loop and the ramp wrapping around it.
        private const float RampGap = 26f;
        // Tilt of a trumpet loop where it meets the stem, so loop and semi-direct ramp leave the node in different directions.
        private const float TrumpetLoopTilt = 25f * math.PI / 180f;
        private const float TrumpetOuterTilt = 10f * math.PI / 180f;

        /// <summary>
        /// AASHTO "Green Book" side-friction factors (metric design speeds, km/h) used with
        /// superelevation e to get the minimum curve radius: R = V^2 / (127 (e + f)).
        /// </summary>
        private static readonly float[,] kSideFriction =
        {
            { 20f, 0.35f }, { 30f, 0.28f }, { 40f, 0.23f }, { 50f, 0.19f }, { 60f, 0.17f },
            { 70f, 0.15f }, { 80f, 0.14f }, { 90f, 0.13f }, { 100f, 0.12f },
        };

        /// <summary>Minimum curve radius (m) for a design speed (km/h) at superelevation e (0.06 = 6 %).</summary>
        public static float MinimumRadius(float speedKmh, float superelevation = 0.06f)
        {
            float v = math.clamp(speedKmh, 20f, 100f);
            float f = kSideFriction[0, 1];
            for (int i = 1; i < kSideFriction.GetLength(0); i++)
            {
                if (v <= kSideFriction[i, 0])
                {
                    float t = (v - kSideFriction[i - 1, 0]) / (kSideFriction[i, 0] - kSideFriction[i - 1, 0]);
                    f = math.lerp(kSideFriction[i - 1, 1], kSideFriction[i, 1], t);
                    break;
                }
            }
            return v * v / (127f * (superelevation + f));
        }

        public static float2 Right(float2 d)
        {
            return new float2(d.y, -d.x);
        }

        /// <summary>Rotates v counter-clockwise (seen from above, +Z up) by angle radians.</summary>
        public static float2 Rotate(float2 v, float angle)
        {
            math.sincos(angle, out float s, out float c);
            return new float2(v.x * c - v.y * s, v.x * s + v.y * c);
        }

        public static bool TryIntersectLines(float2 p1, float2 d1, float2 p2, float2 d2, out float2 point)
        {
            float cross = d1.x * d2.y - d1.y * d2.x;
            point = default;
            if (math.abs(cross) < 1e-4f)
            {
                return false;
            }
            float2 delta = p2 - p1;
            float t = (delta.x * d2.y - delta.y * d2.x) / cross;
            point = p1 + d1 * t;
            return true;
        }

        private sealed class Context
        {
            public InterchangeSite Site;
            public InterchangeOptions Options;
            public RoadProjector Project;
            public readonly List<Ramp> Ramps = new List<Ramp>();
            public readonly List<string> Notes = new List<string>();

            /// <summary>Kerb side of a carriageway: the side ramps leave from and join on.</summary>
            public float2 Curb(float2 travelDir)
            {
                return Site.LeftHandTraffic ? -Right(travelDir) : Right(travelDir);
            }

            /// <summary>Sign of the rotation (counter-clockwise positive) of a turn toward the kerb side.</summary>
            public float Turn => Site.LeftHandTraffic ? 1f : -1f;

            public float2 AxisDir(RoadRole role)
            {
                return role == RoadRole.Major ? Site.MajorDir : Site.MinorDir;
            }

            public RoadRole Other(RoadRole role)
            {
                return role == RoadRole.Major ? RoadRole.Minor : RoadRole.Major;
            }

            /// <summary>Travel direction on the other road reached by turning toward the kerb (true) or across (false).</summary>
            public float2 TurnTarget(RoadRole from, float2 travelDir, bool towardCurb)
            {
                float2 axis = AxisDir(Other(from));
                float2 wanted = towardCurb ? Curb(travelDir) : -Curb(travelDir);
                return math.dot(axis, wanted) >= 0f ? axis : -axis;
            }
        }

        public sealed class Result
        {
            public List<Ramp> Ramps;
            public List<string> Notes;
            public float Radius;
            public float Footprint;
        }

        public static Result Plan(InterchangeSite site, InterchangeOptions options, RoadProjector project)
        {
            var context = new Context { Site = site, Options = options, Project = project };
            switch (options.Type)
            {
                case "diamond":
                    PlanDiamond(context, options.TerminalOffset, loops: null);
                    break;
                case "parclo":
                    PlanParclo(context);
                    break;
                case "cloverleaf":
                    PlanCloverleaf(context);
                    break;
                case "trumpet":
                    PlanTrumpet(context);
                    break;
                default:
                    throw new PlanException($"unknown interchange type '{options.Type}'; use diamond, parclo, cloverleaf or trumpet");
            }
            if (context.Ramps.Count == 0)
            {
                throw new PlanException("no ramp could be planned at this site (the roads carry no matching travel directions)");
            }

            float footprint = 0f;
            foreach (Ramp ramp in context.Ramps)
            {
                Measure(ramp);
                foreach (RampSegment segment in ramp.Segments)
                {
                    footprint = math.max(footprint, math.max(math.distance(segment.Start, site.Center), math.distance(segment.End, site.Center)));
                }
                if (ramp.Grade > MaxGrade)
                {
                    throw new PlanException(
                        $"{ramp.Name} would climb {ramp.Rise:F1} m over {ramp.Length:F0} m ({ramp.Grade * 100f:F1} %), steeper than the " +
                        $"{MaxGrade * 100f:F0} % ramp limit; use a larger radius / rampLength, or a smaller clearance");
                }
                if (ramp.Grade > PreferredGrade)
                {
                    context.Notes.Add($"{ramp.Name}: {ramp.Grade * 100f:F1} % grade is above the preferred {PreferredGrade * 100f:F0} %");
                }
            }
            return new Result { Ramps = context.Ramps, Notes = context.Notes, Radius = options.Radius, Footprint = footprint };
        }

        private static void Measure(Ramp ramp)
        {
            float length = 0f;
            foreach (RampSegment segment in ramp.Segments)
            {
                segment.Length = SegmentLength(segment);
                length += segment.Length;
            }
            ramp.Length = length;
            if (ramp.Segments.Count == 0)
            {
                return;
            }
            // Steepest piece decides, not the average: a stem climbs over one piece only.
            float grade = 0f;
            foreach (RampSegment segment in ramp.Segments)
            {
                if (segment.Length > 1f)
                {
                    grade = math.max(grade, math.abs(segment.E2 - segment.E1) / segment.Length);
                }
            }
            ramp.Grade = grade;
            ramp.Rise = math.abs(ramp.Segments[ramp.Segments.Count - 1].E2 - ramp.Segments[0].E1);
        }

        public static float2 SegmentPoint(RampSegment segment, float t)
        {
            float2 a = segment.Start;
            float2 d = segment.End;
            float2 b;
            float2 c;
            if (segment.HasC1 && segment.HasC2)
            {
                b = segment.C1;
                c = segment.C2;
            }
            else if (segment.HasC1)
            {
                b = a + (segment.C1 - a) * (2f / 3f);
                c = d + (segment.C1 - d) * (2f / 3f);
            }
            else
            {
                b = math.lerp(a, d, 1f / 3f);
                c = math.lerp(a, d, 2f / 3f);
            }
            float u = 1f - t;
            return a * (u * u * u) + b * (3f * u * u * t) + c * (3f * u * t * t) + d * (t * t * t);
        }

        private static float SegmentLength(RampSegment segment)
        {
            float length = 0f;
            float2 previous = segment.Start;
            for (int i = 1; i <= 16; i++)
            {
                float2 point = SegmentPoint(segment, i / 16f);
                length += math.distance(previous, point);
                previous = point;
            }
            return length;
        }

        private static RoadHit Require(Context context, RoadRole role, float2 guess, float2 travelDir, string what, bool anyDirection = false)
        {
            RoadHit hit = context.Project(role, guess, travelDir, anyDirection);
            if (!hit.Found)
            {
                throw new PlanException(
                    $"no {(role == RoadRole.Major ? "major" : "minor")} road carriageway found for the {what} near ({guess.x:F0}, {guess.y:F0}): " +
                    "the road is too short, curves away or ends before that point. Use a smaller radius / rampLength or another site");
            }
            return hit;
        }

        /// <summary>The carriageway travelling travelDir, or Found=false when the road has none (a one-way road).</summary>
        private static RoadHit Carriageway(Context context, RoadRole role, float2 travelDir)
        {
            return context.Project(role, context.Site.Center, travelDir, false);
        }

        private static string Heading(float2 d)
        {
            string[] names = { "E", "NE", "N", "NW", "W", "SW", "S", "SE" };
            float angle = math.atan2(d.y, d.x);
            int index = (int)math.round(angle / (math.PI / 4f));
            return names[((index % 8) + 8) % 8] + "-bound";
        }

        private static string RoleName(RoadRole role)
        {
            return role == RoadRole.Major ? "major" : "minor";
        }

        // ---- Movements -----------------------------------------------------------------------------------

        /// <summary>
        /// A 270-degree (for a right-angle crossing) loop ramp carrying the turn across the other
        /// road: it leaves fromRole's carriageway just past the crossing, circles on the kerb side
        /// and joins the other road just before the crossing, as in a cloverleaf.
        /// </summary>
        private static Ramp AddLoop(Context context, RoadRole fromRole, float2 fromDir, float radius)
        {
            RoadRole toRole = context.Other(fromRole);
            float2 toDir = context.TurnTarget(fromRole, fromDir, towardCurb: false);
            RoadHit from = Carriageway(context, fromRole, fromDir);
            RoadHit to = Carriageway(context, toRole, toDir);
            if (!from.Found || !to.Found)
            {
                return null;
            }

            // Circle tangent to both carriageway lines, on the kerb side of each.
            float2 fromCurb = context.Curb(from.Direction);
            float2 toCurb = context.Curb(to.Direction);
            if (!TryIntersectLines(from.Position + fromCurb * radius, from.Direction, to.Position + toCurb * radius, to.Direction, out float2 center))
            {
                throw new PlanException("the two roads are parallel at the crossing; a loop ramp cannot be fitted");
            }
            RoadHit start = Require(context, fromRole, center - fromCurb * radius, fromDir, "loop exit");
            RoadHit end = Require(context, toRole, center - toCurb * radius, toDir, "loop entrance");
            if (math.dot(start.Position - from.Position, from.Direction) <= 0f || math.dot(end.Position - to.Position, to.Direction) >= 0f)
            {
                throw new PlanException("loop geometry does not fit this crossing angle (the tangent points fall on the wrong side of the crossing)");
            }

            var ramp = new Ramp
            {
                Name = $"loop {RoleName(fromRole)} {Heading(fromDir)} -> {RoleName(toRole)} {Heading(toDir)}",
                Kind = "loop",
                JoinsStart = true,
                JoinsEnd = true,
            };
            AddArc(ramp, center, radius, start.Position, end.Position, context.Turn, start.Elevation, end.Elevation, false);
            context.Ramps.Add(ramp);
            return ramp;
        }

        /// <summary>
        /// Circular arc from start to end around center, turning in the given sense, split into
        /// pieces of at most 45 degrees (a quadratic bezier is within 0.5 % of a circle there).
        /// </summary>
        private static void AddArc(Ramp ramp, float2 center, float radius, float2 start, float2 end, float turn, float e1, float e2, bool minorPrefab)
        {
            float2 v0 = start - center;
            float2 v1 = end - center;
            float a0 = math.atan2(v0.y, v0.x);
            float a1 = math.atan2(v1.y, v1.x);
            float sweep = turn * (a1 - a0);
            while (sweep <= 0.01f)
            {
                sweep += 2f * math.PI;
            }
            while (sweep > 2f * math.PI)
            {
                sweep -= 2f * math.PI;
            }
            int pieces = math.max(1, (int)math.ceil(sweep / PieceAngle - 0.001f));
            float step = sweep / pieces;
            float controlRadius = radius / math.cos(step * 0.5f);
            float2 previous = start;
            for (int i = 0; i < pieces; i++)
            {
                float mid = a0 + turn * step * (i + 0.5f);
                float next = a0 + turn * step * (i + 1);
                float2 point = i == pieces - 1 ? end : center + new float2(math.cos(next), math.sin(next)) * radius;
                ramp.Segments.Add(new RampSegment
                {
                    Start = previous,
                    End = point,
                    HasC1 = true,
                    C1 = center + new float2(math.cos(mid), math.sin(mid)) * controlRadius,
                    E1 = math.lerp(e1, e2, (float)i / pieces),
                    E2 = math.lerp(e1, e2, (float)(i + 1) / pieces),
                    UseMinorPrefab = minorPrefab,
                });
                previous = point;
            }
        }

        /// <summary>
        /// The kerb-side turn as one curve: leaves fromRole's carriageway `reach` before the
        /// crossing and joins the other road `reach` beyond it, tangent to both.
        /// </summary>
        private static Ramp AddOuter(Context context, RoadRole fromRole, float2 fromDir, float reach)
        {
            RoadRole toRole = context.Other(fromRole);
            float2 toDir = context.TurnTarget(fromRole, fromDir, towardCurb: true);
            if (!Carriageway(context, fromRole, fromDir).Found || !Carriageway(context, toRole, toDir).Found)
            {
                return null;
            }
            RoadHit start = Require(context, fromRole, context.Site.Center - fromDir * reach, fromDir, "outer ramp exit");
            RoadHit end = Require(context, toRole, context.Site.Center + toDir * reach, toDir, "outer ramp entrance");
            // Handles of 0.39 x chord make the cubic a near-circular quarter turn.
            float handle = 0.39f * math.distance(start.Position, end.Position);
            var ramp = new Ramp
            {
                Name = $"outer ramp {RoleName(fromRole)} {Heading(fromDir)} -> {RoleName(toRole)} {Heading(toDir)}",
                Kind = "outer",
                JoinsStart = true,
                JoinsEnd = true,
            };
            ramp.Segments.Add(new RampSegment
            {
                Start = start.Position,
                End = end.Position,
                HasC1 = true,
                C1 = start.Position + start.Direction * handle,
                HasC2 = true,
                C2 = end.Position - end.Direction * handle,
                E1 = start.Elevation,
                E2 = end.Elevation,
            });
            context.Ramps.Add(ramp);
            return ramp;
        }

        // ---- Layouts -------------------------------------------------------------------------------------

        /// <summary>
        /// Diamond: per major carriageway an off-ramp before the crossing and an on-ramp after
        /// it, meeting the minor road at one terminal on the kerb side. loops (parclo) adds the
        /// loop ramp of each side and pushes the terminal out beyond it.
        /// </summary>
        private static void PlanDiamond(Context context, float terminalOffset, string loops)
        {
            float length = context.Options.RampLength;
            int built = 0;
            foreach (float2 dir in new[] { context.Site.MajorDir, -context.Site.MajorDir })
            {
                RoadHit major = Carriageway(context, RoadRole.Major, dir);
                if (!major.Found)
                {
                    context.Notes.Add($"the major road has no {Heading(dir)} carriageway here; its ramps were left out");
                    continue;
                }
                float2 curb = context.Curb(major.Direction);
                // Two-way major road: stagger exit and entrance so the ramps of both directions do not share a node.
                float stagger = major.TwoWay ? 30f : 0f;
                RoadHit terminal = Require(context, RoadRole.Minor, context.Site.Center + curb * terminalOffset, curb, "ramp terminal", anyDirection: true);
                if (!terminal.TwoWay)
                {
                    context.Notes.Add(
                        $"the minor road is one-way (or a split carriageway) at the {Heading(dir)} ramp terminal: only that carriageway is connected");
                }
                RoadHit exit = Require(context, RoadRole.Major, context.Site.Center - dir * (length + stagger), dir, "off-ramp exit");
                RoadHit entrance = Require(context, RoadRole.Major, context.Site.Center + dir * length, dir, "on-ramp entrance");

                // S-curves: tangent to the major road, arriving at / leaving the terminal square to the minor road.
                float2 across = math.normalizesafe(major.Direction - terminal.Direction * math.dot(major.Direction, terminal.Direction), major.Direction);
                float offHandle = 0.4f * math.distance(exit.Position, terminal.Position);
                var off = new Ramp { Name = $"off-ramp major {Heading(dir)} -> minor", Kind = "off-ramp", JoinsStart = true, JoinsEnd = true };
                off.Segments.Add(new RampSegment
                {
                    Start = exit.Position,
                    End = terminal.Position,
                    HasC1 = true,
                    C1 = exit.Position + exit.Direction * offHandle,
                    HasC2 = true,
                    C2 = terminal.Position - across * offHandle,
                    E1 = exit.Elevation,
                    E2 = terminal.Elevation,
                });
                context.Ramps.Add(off);

                float onHandle = 0.4f * math.distance(terminal.Position, entrance.Position);
                var on = new Ramp { Name = $"on-ramp minor -> major {Heading(dir)}", Kind = "on-ramp", JoinsStart = true, JoinsEnd = true };
                on.Segments.Add(new RampSegment
                {
                    Start = terminal.Position,
                    End = entrance.Position,
                    HasC1 = true,
                    C1 = terminal.Position + across * onHandle,
                    HasC2 = true,
                    C2 = entrance.Position - entrance.Direction * onHandle,
                    E1 = terminal.Elevation,
                    E2 = entrance.Elevation,
                });
                context.Ramps.Add(on);
                built++;

                if (loops == "A")
                {
                    // Loop on-ramp ahead of the crossing: minor traffic heading away on this side turns onto the major road.
                    float2 minorDir = math.dot(context.Site.MinorDir, curb) >= 0f ? context.Site.MinorDir : -context.Site.MinorDir;
                    if (AddLoop(context, RoadRole.Minor, minorDir, context.Options.Radius) == null)
                    {
                        context.Notes.Add($"no loop for major {Heading(dir)}: the minor road has no carriageway heading away from it on that side");
                    }
                }
                else if (loops == "B")
                {
                    // Loop off-ramp beyond the crossing: major traffic turns across onto the minor road.
                    if (AddLoop(context, RoadRole.Major, dir, context.Options.Radius) == null)
                    {
                        context.Notes.Add($"no loop for major {Heading(dir)}: the minor road has no carriageway for that turn");
                    }
                }
            }
            if (built == 0)
            {
                throw new PlanException("the major road has no carriageway in either direction at this crossing");
            }
        }

        /// <summary>
        /// Partial cloverleaf (Parclo A4 / B4, the Ontario 400-series standard): a diamond whose
        /// left turns at the ramp terminals are replaced by loop ramps, with the terminals moved
        /// out beyond the loops.
        /// </summary>
        private static void PlanParclo(Context context)
        {
            string variant = string.Equals(context.Options.Variant, "B", StringComparison.OrdinalIgnoreCase) ? "B" : "A";
            float terminal = math.max(context.Options.TerminalOffset, 2f * context.Options.Radius + RampGap + 20f);
            float needed = 5f * context.Options.Radius + 60f;
            if (context.Options.RampLength < needed)
            {
                context.Notes.Add($"rampLength raised from {context.Options.RampLength:F0} to {needed:F0} m so the ramps clear the loops");
                context.Options.RampLength = needed;
            }
            PlanDiamond(context, terminal, variant);
        }

        /// <summary>
        /// Full cloverleaf: four loops for the turns across and four outer ramps for the kerb-side
        /// turns, with no traffic signals and no extra bridge. The outer ramps start far enough
        /// out to pass around the loops.
        /// </summary>
        private static void PlanCloverleaf(Context context)
        {
            float radius = context.Options.Radius;
            var loopReach = new List<float>();
            var approaches = new List<KeyValuePair<RoadRole, float2>>
            {
                new KeyValuePair<RoadRole, float2>(RoadRole.Major, context.Site.MajorDir),
                new KeyValuePair<RoadRole, float2>(RoadRole.Major, -context.Site.MajorDir),
                new KeyValuePair<RoadRole, float2>(RoadRole.Minor, context.Site.MinorDir),
                new KeyValuePair<RoadRole, float2>(RoadRole.Minor, -context.Site.MinorDir),
            };
            float farthest = 0f;
            foreach (KeyValuePair<RoadRole, float2> approach in approaches)
            {
                Ramp loop = AddLoop(context, approach.Key, approach.Value, radius);
                if (loop == null)
                {
                    context.Notes.Add($"no loop from {RoleName(approach.Key)} {Heading(approach.Value)}: a carriageway for that turn is missing");
                    continue;
                }
                foreach (RampSegment segment in loop.Segments)
                {
                    farthest = math.max(farthest, math.distance(segment.End, context.Site.Center));
                }
            }
            // A quarter-turn outer ramp passes 0.414 x reach from the crossing at its nearest; it must clear the loops.
            float reach = math.max(context.Options.RampLength, (farthest + RampGap) / 0.414f);
            foreach (KeyValuePair<RoadRole, float2> approach in approaches)
            {
                if (AddOuter(context, approach.Key, approach.Value, reach) == null)
                {
                    context.Notes.Add($"no outer ramp from {RoleName(approach.Key)} {Heading(approach.Value)}: a carriageway for that turn is missing");
                }
            }
        }

        /// <summary>
        /// Trumpet for a T: the minor road ends short of the through road. Its stem climbs, bridges
        /// the through road and ends at a fork: the loop from the far carriageway arrives there
        /// and the semi-direct ramp to the far carriageway leaves, wrapping around the loop. The
        /// near carriageway gets two plain kerb-side ramps. One bridge, no signals: the usual
        /// toll-road interchange.
        /// </summary>
        private static void PlanTrumpet(Context context)
        {
            InterchangeSite site = context.Site;
            float radius = context.Options.Radius;
            float clearance = context.Options.Clearance;
            float2 o = math.normalizesafe(site.Center - site.StemStart);
            float stemDistance = math.distance(site.Center, site.StemStart);

            // Far carriageway: its kerb side faces away from the stem; near carriageway: toward it.
            float2 farDir = math.dot(context.Curb(site.MajorDir), o) > 0f ? site.MajorDir : -site.MajorDir;
            float2 nearDir = -farDir;
            RoadHit far = Carriageway(context, RoadRole.Major, farDir);
            RoadHit near = Carriageway(context, RoadRole.Major, nearDir);
            if (!far.Found && !near.Found)
            {
                throw new PlanException("the through road has no carriageway at the stem axis");
            }
            float farOffset = far.Found ? math.dot(far.Position - site.Center, o) : 0f;
            float nearOffset = near.Found ? math.dot(site.Center - near.Position, o) : 0f;
            // The bridge deck clears the through road, wherever that already sits above the terrain.
            clearance += math.max(0f, math.max(far.Found ? far.Elevation : 0f, near.Found ? near.Elevation : 0f));

            // Stem: flat, climb at <= 5 %, then level across the through road to the fork.
            float2 forkPoint = site.Center + o * (math.max(farOffset, 0f) + radius * (1f + math.sin(TrumpetLoopTilt)));
            float bridgeStart = math.max(nearOffset, 0f) + 35f;
            float climbRoom = stemDistance - bridgeStart;
            float rise = math.max(clearance - site.StemElevation, 0f);
            if (climbRoom < math.max(rise / MaxGrade, 30f))
            {
                throw new PlanException(
                    $"the dead end is {stemDistance:F0} m from the through road; the stem needs at least {bridgeStart + rise / MaxGrade:F0} m " +
                    $"to climb {rise:F1} m at {MaxGrade * 100f:F0} %. Shorten the minor road or lower the clearance");
            }
            float climbLength = math.min(climbRoom, math.max(rise / 0.05f, 30f));
            float2 climbEnd = site.Center - o * bridgeStart;
            float2 climbStart = climbEnd - o * climbLength;
            var stem = new Ramp { Name = "stem (two-way) minor -> fork over the through road", Kind = "stem", JoinsStart = true };
            float2 junction = site.StemStart;
            if (math.distance(site.StemStart, climbStart) > 24f)
            {
                stem.Segments.Add(new RampSegment
                {
                    Start = site.StemStart, End = climbStart, E1 = site.StemElevation, E2 = site.StemElevation, UseMinorPrefab = true,
                });
                junction = climbStart;
            }
            else
            {
                climbStart = site.StemStart;
            }
            stem.Segments.Add(new RampSegment { Start = climbStart, End = climbEnd, E1 = site.StemElevation, E2 = clearance, UseMinorPrefab = true });
            stem.Segments.Add(new RampSegment { Start = climbEnd, End = forkPoint, E1 = clearance, E2 = clearance, UseMinorPrefab = true });
            context.Ramps.Add(stem);

            if (far.Found)
            {
                // Loop: leaves the far carriageway beyond the stem, circles on its kerb side and lands on the fork.
                float2 loopCenter = forkPoint - Rotate(-far.Direction, context.Turn * -TrumpetLoopTilt) * radius;
                loopCenter = far.Position + far.Direction * math.dot(loopCenter - far.Position, far.Direction) + context.Curb(far.Direction) * radius;
                RoadHit loopExit = Require(context, RoadRole.Major, loopCenter - context.Curb(far.Direction) * radius, farDir, "trumpet loop exit");
                var loop = new Ramp { Name = $"loop major {Heading(farDir)} -> minor", Kind = "loop", JoinsStart = true, JoinsEnd = true };
                AddArc(loop, loopCenter, radius, loopExit.Position, forkPoint, context.Turn, loopExit.Elevation, clearance, false);
                context.Ramps.Add(loop);

                // Semi-direct: leaves the fork, passes over the top of the loop and round its far side, then joins.
                float outerRadius = radius + RampGap;
                float2 top = loopCenter + o * outerRadius;
                float2 side = loopCenter + far.Direction * outerRadius;
                float2 sideFoot = side - o * radius;
                RoadHit merge = Require(context, RoadRole.Major, sideFoot + far.Direction * math.max(radius, 60f), farDir, "semi-direct ramp entrance");
                float2 leave = Rotate(o, context.Turn * TrumpetOuterTilt);
                float firstHandle = 0.5f * math.distance(forkPoint, top);
                float firstLength = math.distance(forkPoint, top) * 1.15f;
                float arcLength = outerRadius * math.PI * 0.5f;
                float lastLength = math.distance(side, merge.Position) * 1.1f;
                float total = firstLength + arcLength + lastLength;
                float eTop = math.lerp(clearance, merge.Elevation, firstLength / total);
                float eSide = math.lerp(clearance, merge.Elevation, (firstLength + arcLength) / total);
                var semi = new Ramp { Name = $"semi-direct ramp minor -> major {Heading(farDir)}", Kind = "semi-direct", JoinsStart = true, JoinsEnd = true };
                semi.Segments.Add(new RampSegment
                {
                    Start = forkPoint,
                    End = top,
                    HasC1 = true,
                    C1 = forkPoint + leave * firstHandle,
                    HasC2 = true,
                    C2 = top - far.Direction * firstHandle,
                    E1 = clearance,
                    E2 = eTop,
                });
                AddArc(semi, loopCenter, outerRadius, top, side, -context.Turn, eTop, eSide, false);
                semi.Segments.Add(new RampSegment
                {
                    Start = side,
                    End = merge.Position,
                    HasC1 = true,
                    C1 = merge.Position - merge.Direction * math.dot(merge.Position - side, merge.Direction),
                    E1 = eSide,
                    E2 = merge.Elevation,
                });
                context.Ramps.Add(semi);
            }
            else
            {
                context.Notes.Add("the through road has no carriageway on the far side of the stem; loop and semi-direct ramp were left out");
            }

            if (near.Found)
            {
                // Near side: two kerb-side ramps between the near carriageway and the foot of the stem.
                float reach = math.max(context.Options.RampLength * 0.6f, math.dot(site.Center - junction, o) + 20f);
                RoadHit exit = Require(context, RoadRole.Major, site.Center - nearDir * reach, nearDir, "near-side off-ramp exit");
                RoadHit entrance = Require(context, RoadRole.Major, site.Center + nearDir * reach, nearDir, "near-side on-ramp entrance");
                float2 arrive = math.normalize(nearDir - o);
                float2 depart = math.normalize(nearDir + o);
                float offHandle = 0.4f * math.distance(exit.Position, junction);
                var off = new Ramp { Name = $"off-ramp major {Heading(nearDir)} -> minor", Kind = "off-ramp", JoinsStart = true, JoinsEnd = true };
                off.Segments.Add(new RampSegment
                {
                    Start = exit.Position,
                    End = junction,
                    HasC1 = true,
                    C1 = exit.Position + exit.Direction * offHandle,
                    HasC2 = true,
                    C2 = junction - arrive * offHandle,
                    E1 = exit.Elevation,
                    E2 = site.StemElevation,
                });
                context.Ramps.Add(off);
                float onHandle = 0.4f * math.distance(junction, entrance.Position);
                var on = new Ramp { Name = $"on-ramp minor -> major {Heading(nearDir)}", Kind = "on-ramp", JoinsStart = true, JoinsEnd = true };
                on.Segments.Add(new RampSegment
                {
                    Start = junction,
                    End = entrance.Position,
                    HasC1 = true,
                    C1 = junction + depart * onHandle,
                    HasC2 = true,
                    C2 = entrance.Position - entrance.Direction * onHandle,
                    E1 = site.StemElevation,
                    E2 = entrance.Elevation,
                });
                context.Ramps.Add(on);
            }
            else
            {
                context.Notes.Add("the through road has no carriageway on the near side of the stem; the near-side ramps were left out");
            }
        }
    }
}
