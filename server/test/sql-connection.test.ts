import { describe, expect, test } from "bun:test";
import { setLanguage } from "../src/i18n.ts";
import { sqlConfigProblem, sqlConnectionString } from "../src/ipc/sql-connection.ts";

describe("sqlConnectionString", () => {
  test("高级模式的连接串原样使用，优先于表单字段", () => {
    const raw = "postgresql://u:p@h/db";
    expect(sqlConnectionString({ driver: "mysql", host: "other" }, { connection_string: raw })).toBe(raw);
  });

  test("各数据库用默认端口与驱动，并带上缩短连接等待的参数", () => {
    const pg = new URL(sqlConnectionString({ driver: "postgresql", host: "h", database: "d", username: "u" }, {}));
    expect(pg.protocol).toBe("postgresql+psycopg:");
    expect(pg.port).toBe("5432");
    expect(pg.searchParams.get("connect_timeout")).toBe("10");
    expect(pg.searchParams.has("sslmode")).toBe(false);

    const my = new URL(sqlConnectionString({ driver: "mysql", host: "h", database: "d" }, {}));
    expect(my.protocol).toBe("mysql+pymysql:");
    expect(my.port).toBe("3306");

    const ms = new URL(sqlConnectionString({ driver: "mssql", host: "h", database: "d", ssl: "true" }, {}));
    expect(ms.port).toBe("1433");
    expect(ms.searchParams.get("driver")).toBe("ODBC Driver 18 for SQL Server");
    expect(ms.searchParams.get("Encrypt")).toBe("yes");
  });

  test("IPv6 主机加方括号；没有用户名时不写 @", () => {
    const text = sqlConnectionString({ driver: "postgresql", host: "::1", port: "5432", database: "d" }, {});
    expect(text.startsWith("postgresql+psycopg://[::1]:5432/d?")).toBe(true);
  });

  test("SQLite 用文件路径，绝对路径得到四个斜杠", () => {
    expect(sqlConnectionString({ driver: "sqlite", file: "/tmp/a.db" }, {})).toBe("sqlite:////tmp/a.db");
  });
});

describe("sqlConfigProblem", () => {
  test("端口只接受 1–65535 的数字", () => {
    const check = (port: string) => sqlConfigProblem({ driver: "postgresql", host: "h", port }, {})?.reason;
    expect(check("")).toBeUndefined();
    expect(check("5432")).toBeUndefined();
    expect(check("0")).toBe("invalid_port");
    expect(check("65536")).toBe("invalid_port");
    expect(check("54a2")).toBe("invalid_port");
  });

  test("数据库名和 SQLite 路径里的 ? 会被拒绝，因为连接串无法转义它", () => {
    expect(sqlConfigProblem({ driver: "postgresql", host: "h", database: "a?b" }, {})?.reason).toBe("invalid_database");
    expect(sqlConfigProblem({ driver: "sqlite", file: "/tmp/a?.db" }, {})?.reason).toBe("invalid_file");
  });
});

describe("sqlConfigProblem messages follow the UI language", () => {
  test("English by default, Chinese when the UI language is zh", () => {
    expect(sqlConfigProblem({ driver: "postgresql" }, {})?.message).toBe("Host cannot be empty");
    setLanguage("zh");
    try {
      expect(sqlConfigProblem({ driver: "postgresql" }, {})?.message).toBe("主机不能为空");
    } finally {
      setLanguage("en");
    }
  });
});
