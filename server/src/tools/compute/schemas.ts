/**
 * 14 个 B 类工具的面向前端的定义：JSON Schema 与中文描述逐字复制自
 * `agent/tools/schemas.py` 中同名 `function`（包括 `_ANALYZE_GUIDE` 与 `_CHART_IDS`
 * 插值后的最终文本）。工具实现与 schema 分开放，是因为 schema 面向模型、体量大，
 * 而仓库里的 `registry.ts` 只描述运行时策略。
 *
 * 修改这里的任何字符串都会改变模型行为；改动前先对照 Python 源文件。
 */

export type ComputeToolSchema = {
  readonly description: string;
  readonly parameters: object;
};

export const TOOL_SCHEMAS = {
  query_knowledge: {
    description: "Search the business knowledge base for metric definitions, business rules, context notes, and retrieved document chunks from the local RAG index. ALWAYS call this at the start of any data analysis request BEFORE writing SQL — the knowledge base may contain canonical definitions, pre-built SQL templates, business rules, or source-document context that must be followed. Search by the user's exact keywords (Chinese or English). If results are returned, follow the sql_template and definition exactly and use document chunks as grounded context. Only skip this call for schema exploration (get_schema) or purely structural questions that have no business metric involved.",
    parameters:
    {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "The user's question, metric name, or business concept to look up. Use the original user wording — e.g. '日活', 'DAU', '次日留存率', '客户流失', 'LTV', '复购率'. Both Chinese and English are supported."
        }
      },
      "required": [
        "question"
      ]
    },
  },
  get_schema: {
    description: "Get the schema of the connected data source — table names and columns. For large databases (>20 tables) only the table inventory and the first 20 tables' columns are returned in full; use get_table_detail for any specific table you need to query. Always call this first when the user asks about data you haven't seen yet. The schema is always fetched fresh from the database — never cached between turns.",
    parameters:
    {
      "type": "object",
      "properties": {}
    },
  },
  get_table_detail: {
    description: "Get the full column list and row count for a single table. Use this when get_schema returned only a summary for a table (i.e. the database has more than 20 tables) and you need to know the exact column names before writing a SQL query.",
    parameters:
    {
      "type": "object",
      "properties": {
        "table_name": {
          "type": "string",
          "description": "Exact table name as returned by get_schema."
        }
      },
      "required": [
        "table_name"
      ]
    },
  },
  create_analysis_table: {
    description: "Extract specific fields from the raw data and materialise the result as a new queryable table. Use this to: (1) select only the columns needed for the current analysis, (2) pre-aggregate or filter large datasets before charting, (3) join / reshape data into the exact shape a chart requires. The resulting table is immediately available to query_data and generate_chart by its table_name.",
    parameters:
    {
      "type": "object",
      "properties": {
        "sql": {
          "type": "string",
          "description": "SQL that defines the analysis table — SELECT the exact columns needed, apply WHERE filters, GROUP BY aggregations, JOINs; or a write statement (CREATE/INSERT/UPDATE/DELETE) to prep data in memory. Writes stay in the in-memory cache and never modify the original files."
        },
        "table_name": {
          "type": "string",
          "description": "Name for the new temp table (default: 'analysis_data'). Use a descriptive name when creating multiple tables."
        },
        "purpose": {
          "type": "string",
          "description": "One sentence describing the business goal of this query — e.g. '统计各区域销售额占比用于结构分析'. Shown to the user in the tool timeline alongside the validation badge."
        }
      },
      "required": [
        "sql"
      ]
    },
  },
  delete_analysis_tables: {
    description: "Delete one or more derived/analysis tables from the connected data source. Use this only after the user explicitly confirms the exact table names. The tool refuses to delete raw/source tables or tables that cannot be proven to be analysis/derived objects.",
    parameters:
    {
      "type": "object",
      "properties": {
        "table_names": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Exact analysis table names to delete.",
          "minItems": 1
        },
        "confirm": {
          "type": "boolean",
          "description": "Must be true after confirming the exact table names."
        }
      },
      "required": [
        "table_names",
        "confirm"
      ]
    },
  },
  query_data: {
    description: "Execute a SQL query (SELECT, or a write statement for in-memory data prep) and return the results as a table.",
    parameters:
    {
      "type": "object",
      "properties": {
        "sql": {
          "type": "string",
          "description": "A valid SQL statement using actual column/table names from the schema. SELECT for queries; CREATE TABLE / INSERT / UPDATE / DELETE for data prep — all writes apply only to the in-memory cache and never modify the original files."
        },
        "purpose": {
          "type": "string",
          "description": "One sentence describing the business goal of this query — e.g. '统计各月销售额趋势', '对比 A/B 两组转化率'. Shown to the user in the tool timeline alongside the SQL validation badge, so always fill it in. Keep it under ~40 chars."
        }
      },
      "required": [
        "sql"
      ]
    },
  },
  run_analysis: {
    description: "Run a built-in statistical analysis template on the data.\nSteps: (1) call get_schema to know the tables/columns, (2) call run_analysis with the appropriate parameters, (3) the result is stored as queryable tables — call generate_chart on them.\n\nAvailable analyses:\n  AB_Test_Analysis               — 比较两组单位级实验数据，输出 SRM、显著性检验、95% 置信区间与提升幅度。\n    必填参数: target_column, groupby_column │ 可选参数: analysis_options.control_group, analysis_options.metric_type, analysis_options.expected_allocation\n  Data_Decile_Analysis           — 将数值指标按大小等频分桶，计算每桶的 count/sum/mean/median/std/min/max/值域范围/占比/累计占比，验证 Pareto 效应，适用于客户价值分层、销售分布剖析、ESG \n    必填参数: target_column │ 可选参数: groupby_column, n_deciles\n  Decision_Tree                  — 使用 ID3 / C4.5 / CART 决策树对数据进行分类分析。输出特征重要性、训练/测试准确率、混淆矩阵及 ROC 曲线（含 AUC）。通过 groupby_column 参数指定算法（ID3/\n    必填参数: target_column │ 可选参数: groupby_column (algorithm: ID3 / C4.5 / CART, default C4.5), n_deciles (max_depth: 0=unlimited, default 0)\n  K_Means                        — 对数值型特征执行 K-Means 聚类（K-Means++ 初始化，Z-score 标准化）。自动计算肘部曲线（SSE）和轮廓系数，辅助选择最优 K。通过 n_deciles 参数指定簇数 K（默认 \n    必填参数: target_column │ 可选参数: groupby_column (optional label column for cluster purity), n_deciles (K: number of clusters, default 3)\n  Logistic_Regression            — 使用逻辑回归对数据进行二分类或多分类分析（OvR 策略）。输出特征系数与重要性、训练/测试准确率、混淆矩阵及 ROC 曲线（含 AUC）。通过 groupby_column 参数传入正则化强度（lam\n    必填参数: target_column │ 可选参数: groupby_column (L2 regularization lambda, default 0.01), n_deciles (max_iter: default 1000)\n  Regression                     — 使用最小二乘法（OLS）进行线性回归或多项式回归，支持多元特征与岭回归正则化。输出系数表（含 t 统计量与 p 值）、残差诊断表及 R² / RMSE / MAE 等评估指标。通过 groupby_c\n    必填参数: target_column │ 可选参数: groupby_column (ridge lambda, default 0 = plain OLS), n_deciles (polynomial degree, default 1 = linear)\n  Sklearn_Model                  — 使用 scikit-learn 进行通用机器学习建模：分类（随机森林/逻辑回归）、回归（随机森林/线性/岭回归）、聚类（KMeans），自动预处理缺失值与类别特征，输出评估指标、特征重要性或聚类结果及\n    必填参数: target_column │ 可选参数: groupby_column (model: rf / lr / lm / ridge / kmeans, default rf), n_deciles (kmeans 聚类数 或 随机种子, default 42)\n  Torch_MLP                      — 使用可选 PyTorch 训练 MLP 分类或回归模型，自动选择可用 CUDA 或 CPU。groupby_column 使用 mlp_cls（默认）或 mlp_reg；n_deciles 为训练 e\n    必填参数: target_column │ 可选参数: groupby_column (mlp_cls / mlp_reg), n_deciles (训练 epoch, default 60)\n  Torch_RNN                      — 使用可选 PyTorch 训练 GRU 或 LSTM 时间序列预测模型，自动选择可用 CUDA 或 CPU，支持多步滚动预测与 MC Dropout 置信区间估计。groupby_column 为时间\n    必填参数: target_column │ 可选参数: groupby_column (时间列名，默认自动探测；传 lstm 切换 LSTM 单元), n_deciles (预测步数, default 12)\n  Univariate_Screening           — 对每个候选自变量分别与目标变量做简单 OLS 回归，输出系数、标准误、t 统计量、p 值、R²，并按显著性（默认 p<0.05）分类汇总。适用于多元建模前的变量预筛选。\n    必填参数: target_column │ 可选参数: groupby_column (significance threshold, default '0.05')\n  Time_Series_ARIMA              — 使用 ARIMA 模型对单变量时间序列进行建模与预测。pmdarima auto_arima stepwise 在全量数据上搜索最优阶数，输出预测值、置信区间与残差诊断。通过 groupby_colu\n    必填参数: target_column │ 可选参数: groupby_column (时间列名，或手动阶数 'p,d,q'，默认自动), n_deciles (预测步数，默认 12)\n  Time_Series_SARIMA             — 使用 SARIMA 模型对含季节性波动的单变量时间序列建模预测。自动推断季节周期、执行 ADF 检验、AIC 选阶，输出预测值与季节分解结果。通过 groupby_column 指定时间列名或季节周期\n    必填参数: target_column │ 可选参数: groupby_column (时间列名，或季节周期数字如 '12'/'4'/'7'，默认自动推断), n_deciles (预测步数，默认 12)\n  Time_Series_VAR                — 使用向量自回归（VAR）对多个相关时间序列变量联合建模，捕捉变量间动态依赖关系。自动选择滞后阶数，输出各变量预测值与格兰杰因果检验结果。通过 groupby_column 指定时间列名（或逗号分隔的多\n    必填参数: target_column │ 可选参数: groupby_column (时间列名；或逗号分隔的多个变量列名如 'sales,cost'), n_deciles (预测步数，默认 6)\n  Time_Series_Prophet            — 使用 Prophet 加法分解框架（趋势 + 季节性 + 残差）预测时间序列，纯 numpy+pandas 实现，无需安装 prophet/fbprophet 包。自动识别年度 / 周度 / 日内季节\n    必填参数: target_column │ 可选参数: groupby_column (时间列名，默认自动探测), n_deciles (预测步数，默认 30)\n  Time_Series_GRU                — 使用门控循环单元（GRU）神经网络预测时间序列，纯 numpy 从零实现，无需 keras/tensorflow。支持多步滚动预测与置信区间估计（蒙特卡洛 dropout 近似）。通过 groupby\n    必填参数: target_column │ 可选参数: groupby_column (时间列名，默认自动探测), n_deciles (预测步数，默认 12)",
    parameters:
    {
      "type": "object",
      "properties": {
        "analysis_name": {
          "type": "string",
          "description": "Analysis ID, e.g. 'Data_Decile_Analysis'."
        },
        "sql": {
          "type": "string",
          "description": "SQL SELECT to fetch the raw data for analysis. Include the target column and any optional groupby column. Example: SELECT revenue, region FROM sales_data"
        },
        "target_column": {
          "type": "string",
          "description": "The numeric column to analyse (must exist in the SQL result)."
        },
        "groupby_column": {
          "type": "string",
          "description": "(Optional) A categorical column for additional breakdown."
        },
        "n_deciles": {
          "type": "integer",
          "description": "Number of buckets (default 10). Use 5 for quintiles, 4 for quartiles."
        },
        "analysis_options": {
          "type": "object",
          "description": "Analysis-specific options. For AB_Test_Analysis: control_group, metric_type (auto/binary/continuous), expected_allocation."
        },
        "purpose": {
          "type": "string",
          "description": "One sentence describing the business goal of this analysis — e.g. '对收入做十分位分析识别高价值客群'. Shown to the user in the tool timeline alongside the SQL validation badge."
        }
      },
      "required": [
        "analysis_name",
        "sql",
        "target_column"
      ]
    },
  },
  generate_chart: {
    description: "Create a data visualization chart displayed to the user. IMPORTANT: Call select_chart first to confirm the correct chart_id and field_mapping keys. Use the exact required_roles returned by select_chart as your field_mapping keys.",
    parameters:
    {
      "type": "object",
      "properties": {
        "chart_type": {
          "type": "string",
          "description": "Exact chart_id from the registry. Available: Marimekko_ABS, Marimekko_PCT, Bar_Chart, Grouped_Bar_Chart, Stacked_Bar_Chart, Diverging_Bar_Chart, Dot_Plot, Waffle, Bullet_Chart, Sankey_Chart, Heatmap, Waterfall, Line_Chart, Circular_Line_Chart, Slope_Chart, Sparkline, Bump_Chart, Cycle_Chart, Area_Chart, Stacked_Area_Chart, Horizon_Chart, Connected_Scatter, Histogram_Pareto_chart, Pyramid_Chart, Error_Bar_Chart, Box-and-Whisker_Plot, Violin_Chart, Ridgeline_Plot, Beeswarm_Plot, Dot_Density_Map, Choropleth_Map, Scatter_Plot, Bubble_Plot, Chord_Diagram, Arc_Chart, Network_Diagram, Parallel_Coordinates_Plot, Treemap, Sunburst_Diagram, Nightingale_Chart, Pie_Chart"
        },
        "sql": {
          "type": "string",
          "description": "SQL query to retrieve data for the chart."
        },
        "field_mapping": {
          "type": "object",
          "description": "Maps chart field roles to column names per the chart's data_format. E.g. {\"x\": \"month\", \"y\": \"revenue\"} or {\"label\": \"product\", \"value\": \"sales\"}. Values must be SQL result column names (or a list of column names). Do not put colors, display-name objects, or raw data arrays in field_mapping."
        },
        "title": {
          "type": "string",
          "description": "Required human-readable chart title shown in the tool timeline and above the visualization."
        },
        "highlight": {
          "type": "string",
          "description": "Optional comma-separated series names or category values to emphasize (max 2): matched elements get the accent color while everything else is dimmed, so the focal point stands out. Use when the user calls out a key series, region, or conclusion. E.g. '预测' or '华东,华南'. Only works for Plotly charts."
        },
        "size": {
          "type": "string",
          "enum": [
            "chat",
            "dashboard",
            "slide",
            "square",
            "print"
          ],
          "description": "Output size preset: 'chat' (default, responsive inside the conversation), 'dashboard' 960x480 card, 'slide' 1280x720 full-slide 16:9 for decks, 'square' 800x800 report figure, 'print' 1600x900 hi-res. Only affects Plotly charts."
        },
        "color_scheme": {
          "type": "string",
          "enum": [
            "mckinsey",
            "bcg",
            "bain",
            "ey"
          ],
          "description": "Optional color palette for this chart: 'mckinsey' (default), 'bcg', 'bain', 'ey'. Use when the user asks for a different color theme, firm style, or brand for THIS chart without changing the session-wide scheme."
        },
        "purpose": {
          "type": "string",
          "description": "One sentence describing the data-fetching goal of this query — e.g. '按月聚合销售额用于趋势折线图'. Shown to the user alongside the SQL validation badge."
        }
      },
      "required": [
        "chart_type",
        "sql",
        "field_mapping",
        "title"
      ]
    },
  },
  profile_data: {
    description: "Profile a data table before analysis: row/column count, dtype, SQL missing %, pseudo-null strings such as 'null'/'NaN'/'N/A', date parse rates, and numeric mean/std/min/max/quartiles. Also generates distribution histogram charts automatically. Call this for the /data command and before create_analysis_table when key filters depend on missing values, dates, ids or labels. If the profile reports pseudo-null strings or low date parse rates, clean or explain the blocker before computing key metrics.",
    parameters:
    {
      "type": "object",
      "properties": {
        "table_name": {
          "type": "string",
          "description": "Table to profile. Leave empty to use the first available table."
        },
        "columns": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional list of columns to limit profiling to."
        }
      },
      "required": []
    },
  },
  clean_data: {
    description: "Clean data in-place and store result as 'cleaned_data' table. Supports three operations:\n  fill_na   — fill NaN with zero / mean / median\n  winsorize — cap values at lower/upper percentiles\n  trimming  — remove rows outside [min_val, max_val] on one column",
    parameters:
    {
      "type": "object",
      "properties": {
        "operation": {
          "type": "string",
          "description": "One of: fill_na | winsorize | trimming"
        },
        "table_name": {
          "type": "string",
          "description": "Source table name. Leave empty to use the first available raw table."
        },
        "columns": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Columns to process (fill_na / winsorize). None = all numeric columns."
        },
        "fill_method": {
          "type": "string",
          "description": "For fill_na: 'zero' | 'mean' | 'median'"
        },
        "lower_pct": {
          "type": "number",
          "description": "For winsorize: lower percentile, 0–100 (e.g. 1 for 1st percentile)"
        },
        "upper_pct": {
          "type": "number",
          "description": "For winsorize: upper percentile, 0–100 (e.g. 99 for 99th percentile)"
        },
        "trim_column": {
          "type": "string",
          "description": "For trimming: the column to filter on"
        },
        "min_val": {
          "type": "number",
          "description": "For trimming: minimum value to keep (inclusive)"
        },
        "max_val": {
          "type": "number",
          "description": "For trimming: maximum value to keep (inclusive)"
        },
        "output_table": {
          "type": "string",
          "description": "Name for the result table (default: 'cleaned_data')"
        }
      },
      "required": [
        "operation"
      ]
    },
  },
  export_excel: {
    description: "Export data tables to an Excel (.xlsx) file. Call this ONLY when the user explicitly asked to export data. Each table becomes a separate sheet. Pass tables=[\"*\"] to export ALL available tables automatically — this is the default behaviour unless the user asks for specific tables.",
    parameters:
    {
      "type": "object",
      "properties": {
        "tables": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Table names to export. Use [\"*\"] to auto-export every table in the data source (raw data + analysis results). Only specify exact names if the user asked for specific tables."
        },
        "filename": {
          "type": "string",
          "description": "Base filename without extension (optional, auto-generated if omitted)."
        }
      },
      "required": [
        "tables"
      ]
    },
  },
  export_report: {
    description: "Generate a Word document (.docx) analysis report. Call this ONLY when the user explicitly asked to export a report. Query the data first, then compose sections.",
    parameters:
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Report title."
        },
        "sections": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "heading": {
                "type": "string"
              },
              "content": {
                "type": "string",
                "description": "Section body text (plain text or markdown-style)."
              }
            },
            "required": [
              "heading",
              "content"
            ]
          },
          "description": "Ordered list of report sections. Typical structure: Executive Summary → Key Findings → Data Analysis → Recommendations."
        }
      },
      "required": [
        "title",
        "sections"
      ]
    },
  },
  generate_ppt: {
    description: "Generate a professional McKinsey-style PowerPoint (.pptx) presentation.\nONLY called automatically by the system after user confirms a propose_ppt_outline. NEVER call directly.\n\nSLIDE LAYOUTS and their params:\n  cover            title, subtitle?(str), author?(str), date?(str)\n  toc              title?='目录', items(list of [num_str, title, desc])\n  section_divider  section_label(str), title(str), subtitle?(str)\n  big_number       title, number(str), unit?(str), description?(str),\n                   detail_items?(list[str])\n  two_stat         title, stats(list of [number_str, label, is_navy_bool])\n  metric_cards     title, cards(list of [letter, card_title, desc])\n  data_table       title, headers(list[str]), rows(list[list[str]])\n  table_insight    title, headers(list[str]), rows(list[list[str]]),\n                   insights(list[str])\n  executive_summary title, headline(str),\n                   items(list of [num_str, item_title, desc])\n  two_column_text  title, columns(list of [letter, col_title,\n                   points(list[str])])\n  action_items     title, actions(list of [action_title, timeline, desc, owner])\n  donut            title, segments(list of [pct_float, color_str, label]),\n                   center_label?(str), center_sub?(str)\n  grouped_bar      title, categories(list[str]),\n                   series(list of [name, color_str]),\n                   data(list[list[num]]), max_val?(num)\n  stacked_bar      title, periods(list[str]),\n                   series(list of [name, color_str]),\n                   data(list[list[num]] — percentages 0-100)\n  timeline         title, milestones(list of [label, description])\n  closing          title, message?(str)\n\nColor string constants for color params:\n  NAVY (primary dark), ACCENT_BLUE, ACCENT_GREEN, ACCENT_ORANGE, ACCENT_RED,\n  BG_GRAY, LIGHT_BLUE, LIGHT_GREEN, LIGHT_ORANGE, LIGHT_RED, MED_GRAY",
    parameters:
    {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Overall deck title (used for the filename)."
        },
        "slides": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "layout": {
                "type": "string",
                "description": "Slide layout name, e.g. 'cover', 'donut', 'timeline'."
              },
              "params": {
                "type": "object",
                "description": "Parameters matching the chosen layout's signature."
              }
            },
            "required": [
              "layout",
              "params"
            ]
          },
          "description": "Ordered list of slides. Each item: {layout, params}."
        },
        "filename": {
          "type": "string",
          "description": "Optional base filename without extension."
        }
      },
      "required": [
        "title",
        "slides"
      ]
    },
  },
  generate_dashboard: {
    description: "Generate and save an interactive dashboard with multiple chart widgets.\nOnly call this after the user confirms a proposed outline via the UI button,\nor when the dashboard_confirm command is active.\nEach widget executes SQL against the connected data source and renders a chart.",
    parameters:
    {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Dashboard name."
        },
        "widgets": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string"
              },
              "chart_type": {
                "type": "string",
                "enum": [
                  "Bar_Chart",
                  "Line_Chart",
                  "Pie_Chart",
                  "Scatter_Plot",
                  "Area_Chart",
                  "Grouped_Bar_Chart",
                  "Heatmap",
                  "Stacked_Bar_Chart",
                  "KPI_Card"
                ],
                "description": "Chart type. Use KPI_Card for scalar metric display (SQL must return 1 row: col1=value, col2=subtitle (opt), col3=trend% (opt))."
              },
              "sql": {
                "type": "string"
              },
              "field_mapping": {
                "type": "object",
                "description": "Maps chart axes/roles to SQL result column names. Never use placeholder strings like 'category'."
              },
              "options": {
                "type": "object"
              },
              "grid": {
                "type": "object",
                "description": "{x, y, w, h} grid position. KPI_Card recommended: w=3, h=2."
              }
            },
            "required": [
              "title",
              "chart_type",
              "sql",
              "field_mapping"
            ]
          }
        },
        "color_scheme": {
          "type": "string",
          "enum": [
            "mckinsey",
            "bcg",
            "bain",
            "ey"
          ],
          "description": "Color scheme (defaults to current session scheme)."
        }
      },
      "required": [
        "name",
        "widgets"
      ]
    },
  },
} as const satisfies Record<string, ComputeToolSchema>;

