import { ROLES } from "@/shared/lib/roles";
import { describe, it, expect, vi, beforeEach } from "vitest";

// EMAIL_LOG carries recipient names and addresses and is service-role-only at
// the database layer, so the role floor in the handler is the only gate. The
// detail route used to sit a rank below its own listing, which let a
// facilitator walk the table one integer id at a time — reading exactly the
// rows `GET /api/logs` refuses to show them.
const { requireMinRole, emailFindById, emailList } = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  emailFindById: vi.fn(),
  emailList: vi.fn(),
}));

vi.mock("@/modules/auth/lib/role-guard", () => ({ requireMinRole }));
vi.mock("@/shared/db/client", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/shared/db/dao/email.dao", () => ({ findById: emailFindById, list: emailList }));

import { GET as GET_LOG } from "@/app/api/logs/[id]/route";
import { GET as GET_LOGS } from "@/app/api/logs/route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("https://app.test/api/logs/1");

beforeEach(() => {
  vi.clearAllMocks();
  emailFindById.mockResolvedValue({ id: 1, USER: { full_name: "A", email: "a@example.com" } });
  emailList.mockResolvedValue({ data: [], count: 0 });
});

describe("GET /api/logs/[id] enforces the same floor as the listing", () => {
  it("demands ADMIN, matching GET /api/logs", async () => {
    requireMinRole.mockResolvedValue({ allowed: true, error: null, user: { id: 1, role: ROLES.ADMIN } });

    await GET_LOG(req(), params("1"));
    const detailFloor = requireMinRole.mock.calls[0][0];

    requireMinRole.mockClear();
    await GET_LOGS(new Request("https://app.test/api/logs"));
    const listFloor = requireMinRole.mock.calls[0][0];

    expect(detailFloor).toBe(ROLES.ADMIN);
    expect(detailFloor).toBe(listFloor);
  });

  it("refuses a facilitator without reading the row", async () => {
    requireMinRole.mockResolvedValue({ allowed: false, error: "Forbidden", user: { id: 9, role: ROLES.FACILITATOR } });

    const res = await GET_LOG(req(), params("1"));

    expect(res.status).toBe(403);
    expect(emailFindById).not.toHaveBeenCalled();
  });
});
