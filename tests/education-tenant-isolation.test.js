"use strict";

/**
 * LOT 1 — MaliLink Education tenant isolation regression specification.
 *
 * IMPORTANT: these tests are intentionally skipped until the integration-test
 * harness can provision an isolated PostgreSQL database and authenticated
 * School A / School B users. They MUST NOT be reported as passing while skipped.
 *
 * Required fixture contract for the future harness:
 *   ctx.schoolA / ctx.schoolB: company ids
 *   ctx.asA / ctx.asB: authenticated HTTP clients
 *   ctx.A / ctx.B: real persisted ids belonging to each company
 *
 * Every negative case uses a VALID persisted id from School B, never a fake id.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

function expectTenantRefusal(response) {
  assert.ok([403, 404].includes(response.status), `expected 403/404, got ${response.status}`);
}

const pending = (name) => test(name, { skip: "Requires isolated School A/B DB + HTTP auth harness" }, async () => {});

// Direct object access — valid B ids presented by an authenticated A user.
pending("A cannot read School B student");
pending("A cannot modify School B student");
pending("A cannot delete School B student");
pending("A cannot read School B teacher detail or assignments");
pending("A cannot modify/delete School B teacher assignment");
pending("A cannot read School B enrollment");
pending("A cannot generate School B enrollment PDF");
pending("A cannot read School B enrollment payments");
pending("A cannot generate School B enrollment payment receipt");
pending("A cannot read School B fee plan");
pending("A cannot generate School B fee schedule PDF");
pending("A cannot generate School B monthly-payment receipt");
pending("A cannot read School B attendance by student id");
pending("A cannot read School B report card PDF");
pending("A cannot modify School B report card");
pending("A cannot modify/delete School B schedule");
pending("A cannot modify/delete School B course");
pending("A cannot grade School B assignment submission");

// Cross-tenant FK injection — valid B foreign keys in A writes.
pending("A cannot create class with School B school_year_id");
pending("A cannot create class with School B main teacher");
pending("A cannot create term with School B school_year_id");
pending("A cannot create teacher with School B user_id or school_year_id");
pending("A cannot create student in School B class");
pending("A cannot attach School B parent to School A student");
pending("A cannot enroll School A student into School B class");
pending("A cannot enroll School A student into School B school year");
pending("A cannot create fee plan using School B class/year");
pending("A cannot pay School A fee plan using School B installment_id");
pending("A cannot create teacher assignment using School B teacher/class/subject/year/term");
pending("A cannot patch assignment to School B subject/term");
pending("A cannot create schedule with School B assignment/teacher/class/subject/year");
pending("A cannot patch schedule to School B teacher/subject");
pending("A cannot create exam with School B class/subject/term");
pending("A cannot create fee with School B class/year");
pending("A cannot record fee payment using School B fee_id");
pending("A cannot create course/devoir with School B class or subject");
pending("A cannot send education message targeting School B user/student/class");

// Bulk operations: whole request must be rejected, not partially accepted.
pending("roll-call rejects a batch containing one valid School B student_id");
pending("grade entry rejects a batch containing one valid School B student_id");
pending("assignment submission rejects student not belonging to assignment class");

// Positive controls for School A.
pending("A can create/read/update its own student");
pending("A can enroll its student in its class/year");
pending("A can assign its teacher to its class/subject/year/term");
pending("A can record attendance for students in its class");
pending("A can create exam and grades for students in exam class");
pending("A can create fee plan, payment and receipts for its student");
pending("A can create/update its schedule, course and assignment");

module.exports = { expectTenantRefusal };
