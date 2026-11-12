using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using Colossal.UI.Binding;
using Game.UI.InGame;
using Newtonsoft.Json.Linq;

namespace CS2MCP
{
    /// <summary>
    /// The figures of the game's info view panels (Education: students / eligible / capacity per
    /// school level, Healthcare: patients and cemetery use, Garbage: landfill and processing,
    /// Police: jail and prison, ...), read from the panels' own UI systems.
    ///
    /// Those systems only recalculate while their panel is open, so the request runs the system's
    /// PerformUpdate itself and then reads every value binding: the numbers are exactly what the
    /// panel would show now. Getter bindings are read through their getter (no UI event is sent);
    /// raw bindings (JSON written by a callback, e.g. the education distribution) are captured
    /// with a writer that builds a JSON tree.
    /// </summary>
    public sealed partial class RequestHandlers
    {
        private static readonly Dictionary<string, Type> kInfoviews = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase)
        {
            ["education"] = typeof(EducationInfoviewUISystem),
            ["healthcare"] = typeof(HealthcareInfoviewUISystem),
            ["garbage"] = typeof(GarbageInfoviewUISystem),
            ["police"] = typeof(PoliceInfoviewUISystem),
            ["fireAndRescue"] = typeof(FireAndRescueInfoviewUISystem),
            ["disaster"] = typeof(DisasterInfoviewUISystem),
            ["electricity"] = typeof(ElectricityInfoviewUISystem),
            ["water"] = typeof(WaterInfoviewUISystem),
            ["traffic"] = typeof(TrafficInfoviewUISystem),
            ["post"] = typeof(PostInfoviewUISystem),
            ["telecom"] = typeof(TelecomInfoviewUISystem),
            ["transport"] = typeof(TransportInfoviewUISystem),
            ["population"] = typeof(PopulationInfoviewUISystem),
            ["workplaces"] = typeof(WorkplacesInfoviewUISystem),
            ["tourism"] = typeof(TourismInfoviewUISystem),
            ["pollution"] = typeof(PollutionInfoviewUISystem),
        };

        private BridgeResponse GetInfoview(BridgeRequest request)
        {
            if (!TryGetCity(out _, out BridgeResponse error))
            {
                return error;
            }
            string names = string.Join(", ", kInfoviews.Keys);
            if (!request.Query.TryGetValue("view", out string view) || string.IsNullOrWhiteSpace(view))
            {
                return BridgeResponse.Error(400, $"provide ?view=<name>; views: {names}");
            }
            if (!kInfoviews.TryGetValue(view.Trim(), out Type systemType))
            {
                return BridgeResponse.Error(400, $"unknown view '{view}'; views: {names}");
            }

            object system = World.GetExistingSystemManaged(systemType);
            if (system == null)
            {
                return BridgeResponse.Error(503, $"{systemType.Name} is not running (still loading?)");
            }

            // Recalculate as if the panel were open. If that fails the values are the ones from
            // the last time the panel was open (or zero), and the response says so.
            bool refreshed = false;
            string refreshError = null;
            MethodInfo performUpdate = systemType.GetMethod("PerformUpdate", kPrivate | BindingFlags.Public);
            if (performUpdate == null)
            {
                refreshError = "PerformUpdate not found on " + systemType.Name;
            }
            else
            {
                try
                {
                    performUpdate.Invoke(system, null);
                    refreshed = true;
                }
                catch (TargetInvocationException ex)
                {
                    refreshError = (ex.InnerException ?? ex).Message;
                }
                catch (Exception ex)
                {
                    refreshError = ex.Message;
                }
            }

            var values = new Dictionary<string, object>();
            var readErrors = new List<string>();
            foreach (FieldInfo field in systemType.GetFields(kPrivate | BindingFlags.Public | BindingFlags.DeclaredOnly))
            {
                object binding = field.GetValue(system);
                if (binding == null)
                {
                    continue;
                }
                string key = InfoviewKey(field.Name);
                try
                {
                    if (TryReadBinding(binding, out object value))
                    {
                        values[key] = value;
                    }
                }
                catch (Exception ex)
                {
                    readErrors.Add($"{key}: {(ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException.Message : ex.Message)}");
                }
            }

            return BridgeResponse.Json(new
            {
                view = InfoviewName(systemType),
                refreshed,
                refreshError,
                readErrors = readErrors.Count > 0 ? readErrors : null,
                values,
                note = "the figures of the game's info view panel, recalculated for this request. " +
                       "Indicator values are { min, max, current } on the panel's bar.",
            });
        }

        private static string InfoviewName(Type systemType)
        {
            foreach (KeyValuePair<string, Type> pair in kInfoviews)
            {
                if (pair.Value == systemType)
                {
                    return pair.Key;
                }
            }
            return systemType.Name;
        }

        /// <summary>m_ElementaryStudents -> elementaryStudents</summary>
        private static string InfoviewKey(string fieldName)
        {
            string name = fieldName.StartsWith("m_", StringComparison.Ordinal) ? fieldName.Substring(2) : fieldName;
            return name.Length == 0 ? name : char.ToLowerInvariant(name[0]) + name.Substring(1);
        }

        /// <summary>Reads a ValueBinding, GetterValueBinding or RawValueBinding; false for anything else.</summary>
        private static bool TryReadBinding(object binding, out object value)
        {
            value = null;
            Type type = binding.GetType();
            if (type.IsGenericType)
            {
                string definition = type.GetGenericTypeDefinition().Name;
                if (definition == "ValueBinding`1")
                {
                    value = SimplifyInfoviewValue(type.GetProperty("value", BindingFlags.Instance | BindingFlags.Public).GetValue(binding), 0);
                    return true;
                }
                if (definition == "GetterValueBinding`1")
                {
                    // Call the getter instead of Update(): same number, no UI event.
                    var getter = type.GetField("m_Getter", kPrivate)?.GetValue(binding) as Delegate;
                    if (getter == null)
                    {
                        return false;
                    }
                    value = SimplifyInfoviewValue(getter.DynamicInvoke(), 0);
                    return true;
                }
            }
            if (binding is RawValueBinding)
            {
                var writer = type.GetField("m_WriterDelegate", kPrivate)?.GetValue(binding) as Action<IJsonWriter>;
                if (writer == null)
                {
                    return false;
                }
                var capture = new JsonTreeWriter();
                writer(capture);
                value = capture.Result;
                return true;
            }
            return false;
        }

        /// <summary>Numbers, strings and enums as they are; structs (IndicatorValue) as their public members.</summary>
        private static object SimplifyInfoviewValue(object value, int depth)
        {
            if (value == null || value is string || value is bool || value.GetType().IsPrimitive || value is decimal)
            {
                if (value is float f)
                {
                    return float.IsNaN(f) || float.IsInfinity(f) ? (object)null : Math.Round(f, 4);
                }
                if (value is double d)
                {
                    return double.IsNaN(d) || double.IsInfinity(d) ? (object)null : Math.Round(d, 4);
                }
                return value;
            }
            if (value is Enum)
            {
                return value.ToString();
            }
            if (depth >= 3)
            {
                return value.ToString();
            }
            if (value is IEnumerable sequence)
            {
                var list = new List<object>();
                foreach (object item in sequence)
                {
                    if (list.Count >= 100)
                    {
                        break;
                    }
                    list.Add(SimplifyInfoviewValue(item, depth + 1));
                }
                return list;
            }
            var members = new Dictionary<string, object>();
            foreach (PropertyInfo property in value.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public))
            {
                if (property.GetIndexParameters().Length == 0)
                {
                    members[InfoviewKey(property.Name)] = SimplifyInfoviewValue(property.GetValue(value), depth + 1);
                }
            }
            foreach (FieldInfo field in value.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public))
            {
                members[InfoviewKey(field.Name)] = SimplifyInfoviewValue(field.GetValue(value), depth + 1);
            }
            return members;
        }

        /// <summary>Collects what a raw binding writes into a JSON tree.</summary>
        private sealed class JsonTreeWriter : IJsonWriter
        {
            private readonly Stack<JContainer> m_Stack = new Stack<JContainer>();
            private string m_Property;

            public JToken Result { get; private set; }

            public string debugName => "CS2MCP infoview capture";

            private void Add(JToken token)
            {
                if (m_Stack.Count == 0)
                {
                    Result = token;
                    return;
                }
                JContainer parent = m_Stack.Peek();
                if (parent is JObject obj)
                {
                    obj[m_Property ?? "value" + obj.Count] = token;
                    m_Property = null;
                }
                else
                {
                    parent.Add(token);
                }
            }

            private void Open(JContainer container)
            {
                Add(container);
                m_Stack.Push(container);
            }

            private void Close()
            {
                if (m_Stack.Count > 0)
                {
                    m_Stack.Pop();
                }
            }

            public void TypeBegin(string typeName) => Open(new JObject());
            public void TypeEnd() => Close();
            public void MapBegin(uint size) => Open(new JObject());
            public void MapEnd() => Close();
            public void ArrayBegin(uint size) => Open(new JArray());
            public void ArrayEnd() => Close();
            public void PropertyName(string name) => m_Property = name;
            public void WriteNull() => Add(JValue.CreateNull());
            public void Write(bool value) => Add(new JValue(value));
            public void Write(int value) => Add(new JValue(value));
            public void Write(uint value) => Add(new JValue(value));
            public void Write(long value) => Add(new JValue(value));
            public void Write(ulong value) => Add(new JValue(value));
            public void Write(float value) => Add(float.IsNaN(value) || float.IsInfinity(value) ? JValue.CreateNull() : new JValue(Math.Round(value, 4)));
            public void Write(double value) => Add(double.IsNaN(value) || double.IsInfinity(value) ? JValue.CreateNull() : new JValue(Math.Round(value, 4)));
            public void Write(string value) => Add(value == null ? JValue.CreateNull() : new JValue(value));
        }
    }
}
