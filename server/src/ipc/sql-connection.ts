/**
 * 数据库连接表单字段 → SQLAlchemy 连接串。
 *
 * compute（Python）只负责「拿到连接串就连」，因为 SQLDataSource 和它背后的 DuckDB 缓存
 * 是分析工具的数据面；表单字段怎么拼成连接串、哪些组合不合法，属于配置层，在这里做。
 *
 * 密码、用户名用 `encodeURIComponent` 编码，所以 `@`、`/`、`#`、`%` 之类的字符不需要用户转义；
 * SQLAlchemy 解析连接串时会把它们还原。
 */

/** 表单里的数据库类型 → SQLAlchemy 驱动名与默认端口。 */
const DRIVERS = {
  postgresql: { scheme: "postgresql+psycopg", port: 5432 },
  mysql: { scheme: "mysql+pymysql", port: 3306 },
  mssql: { scheme: "mssql+pyodbc", port: 1433 },
  sqlite: { scheme: "sqlite", port: undefined },
} as const;

export type SqlDriver = keyof typeof DRIVERS;

export const SQL_DRIVER_NAMES = Object.keys(DRIVERS) as SqlDriver[];

export type SqlConfigProblem = { message: string; reason: string };

function isDriver(name: string): name is SqlDriver {
  return Object.hasOwn(DRIVERS, name);
}

/**
 * 校验一份 sql 配置能不能拿去连接；合法返回 undefined。
 * 高级模式的 `connection_string` 非空时不再检查其他字段（以连接串为准）。
 */
export function sqlConfigProblem(
  fields: Readonly<Record<string, string>>,
  secret: Readonly<Record<string, string>>,
): SqlConfigProblem | undefined {
  // 调用方可能把连接串误放在 fields 里（存储层会把它挪进凭据库），这里与存储层口径一致。
  if ((secret.connection_string ?? fields.connection_string ?? "") !== "") return undefined;
  const driver = fields.driver ?? "";
  if (driver === "") return { message: "请选择数据库类型，或在高级选项里填写连接串", reason: "missing_driver" };
  if (!isDriver(driver)) return { message: `不支持的数据库类型：${driver}`, reason: "unsupported_driver" };
  if (driver === "sqlite") {
    const file = fields.file ?? "";
    if (file === "") return { message: "SQLite 文件路径不能为空", reason: "missing_file" };
    // `?` 在连接串里是查询参数的分隔符，文件路径没法转义它。
    if (file.includes("?")) return { message: "SQLite 文件路径不能包含 ?", reason: "invalid_file" };
    return undefined;
  }
  if ((fields.host ?? "") === "") return { message: "主机不能为空", reason: "missing_host" };
  const port = fields.port ?? "";
  if (port !== "" && !(/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    return { message: "端口必须是 1–65535 之间的数字", reason: "invalid_port" };
  }
  if ((fields.database ?? "").includes("?")) return { message: "数据库名不能包含 ?", reason: "invalid_database" };
  return undefined;
}

/** 由配置得到连接串；调用前须已通过 `sqlConfigProblem`。 */
export function sqlConnectionString(
  fields: Readonly<Record<string, string>>,
  secret: Readonly<Record<string, string>>,
): string {
  const advanced = secret.connection_string ?? "";
  if (advanced !== "") return advanced;
  const driver = fields.driver ?? "";
  if (!isDriver(driver)) throw new Error(`unsupported sql driver: ${driver}`);
  const { scheme, port: defaultPort } = DRIVERS[driver];
  if (driver === "sqlite") return `${scheme}:///${fields.file ?? ""}`;

  const username = fields.username ?? "";
  const password = secret.password ?? "";
  let auth = "";
  if (username !== "") auth = `${encodeURIComponent(username)}${password === "" ? "" : `:${encodeURIComponent(password)}`}@`;
  const rawHost = fields.host ?? "";
  // IPv6 字面量在 URL 里必须带方括号。
  const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  const port = fields.port === undefined || fields.port === "" ? defaultPort : Number(fields.port);
  const database = fields.database ?? "";
  const ssl = fields.ssl === "true";

  // 主机或端口填错时，驱动默认的等待时间很长；缩短到界面可接受的范围。
  const query = new URLSearchParams();
  if (driver === "postgresql") {
    query.set("connect_timeout", "10");
    if (ssl) query.set("sslmode", "require");
  } else if (driver === "mysql") {
    query.set("connect_timeout", "10");
    query.set("charset", "utf8mb4");
  } else {
    // SQL Server：ODBC Driver 18 默认强制加密，自签证书的本地实例会被拒，所以信任服务器证书。
    query.set("driver", "ODBC Driver 18 for SQL Server");
    query.set("Encrypt", ssl ? "yes" : "no");
    query.set("TrustServerCertificate", "yes");
  }
  return `${scheme}://${auth}${host}:${port}${database === "" ? "" : `/${database}`}?${query.toString()}`;
}
