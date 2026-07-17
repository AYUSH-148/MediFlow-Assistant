# GraphRAG with Neo4j and Pinecone

This document explains how the project uses Neo4j graph queries and Cypher together with Pinecone vector retrieval to build a hybrid GraphRAG workflow.

## What is Cypher?

Cypher is Neo4j's declarative query language for graph data. It is designed to express patterns of connected nodes and relationships using a SQL-like syntax, but for graphs instead of tables.

A simple Cypher query looks like this:

```cypher
MATCH (a:Entity)-[*]->(b:Entity)
WHERE a.name = $start AND b.name = $end
RETURN p
```

In this project:
- `MATCH` finds graph patterns
- `(a:Entity)` and `(b:Entity)` are nodes labeled `Entity`
- `-[*]->` means any directed path between them
- `WHERE` filters by property values
- `RETURN p` returns the full path object

## How Neo4j is used in this app

### 1. Extract triples from PDF reports

When a PDF is uploaded, `app/api/extractreportgemini/route.ts` sends it to Gemini with a prompt asking for:
- a text summary
- medical entity triples in JSON

Those triples are expected in the format:

```json
{
  "subject": "Aspirin",
  "predicate": "treats",
  "object": "Headache"
}
```

The route then stores the extracted triples in Neo4j using `storeTriplesInNeo4j()` from `lib/pii-redaction.ts`.

### 2. Storing triples in Neo4j

The function `storeTriplesInNeo4j(triples)` does the following:
- creates or finds a node for the `subject`
- creates or finds a node for the `object`
- creates a directed relationship from subject to object with the relationship type stored as a property

The Cypher used is:

```cypher
MERGE (a:Entity {name: $subject})
MERGE (b:Entity {name: $object})
MERGE (a)-[:RELATIONSHIP {type: $predicate}]->(b)
```

`MERGE` ensures duplicate nodes or relationships are not created if the same triple is inserted again.

## Querying Neo4j during chat

When the user asks a question, `app/api/medichatgemini/route.ts` performs two retrieval paths:

1. **Pinecone vector search** for raw semantic context
2. **Neo4j graph query** for relationship-based knowledge

### Vector retrieval flow

The code first uses `queryPineconeVectorStore(pinecone, 'medic', 'diagnosis2', query)` from `utils.ts`.
This returns text snippets from the vector store that are semantically similar to the question.

### Graph retrieval flow

The code then attempts a Neo4j graph query:

```ts
const relationships = await queryNeo4jRelationships(entities[0], entities[1]);
```

This function executes Cypher:

```cypher
MATCH p = (a:Entity)-[*]->(b:Entity)
WHERE a.name = $start AND b.name = $end
RETURN p
```

`queryNeo4jRelationships()` returns graph path objects from Neo4j, which are then serialized to JSON and appended to the prompt.

## What is returned from Neo4j?

The `Neo4j` driver returns records containing a `Path` object. In this app, the path is converted with:

```ts
return result.records.map((record) => serializeNeo4jPath(record.get("p")));
```

Where `serializeNeo4jPath()` transforms the raw Neo4j path into clean JSON:

```ts
function serializeNeo4jPath(path: any): any {
  if (path.segments && path.segments.length > 0) {
    const segment = path.segments[0];
    return {
      start: segment.start.properties.name,
      end: segment.end.properties.name,
      relationship: segment.relationship.properties.type,
    };
  }
  return {
    start: path.start?.properties?.name || "Unknown",
    end: path.end?.properties?.name || "Unknown",
    relationship: path.relationship?.properties?.type || "Unknown",
  };
}
```

The value stored in `graphData` becomes a JSON-like string such as:

```text
Entity Relationships: [{"start":"Aspirin","end":"Headache","relationship":"treats"}]
```

## How graph results are appended to vector results

After both retrievals are complete, the final Gemini prompt includes:
- the redacted report summary
- the user query
- the Pinecone retrievals under `Generic Clinical findings`
- the Neo4j retrievals under `Entity Relationships from Knowledge Graph`

That prompt looks like:

```text
**Generic Clinical findings:**
${retrievals}.

**Entity Relationships from Knowledge Graph:**
${graphData}
```

This means Gemini receives a blended context of:
- semantic text passages from Pinecone
- relationship paths from Neo4j

## Why this matters

- Pinecone provides similarity-based context, which helps answer questions using relevant text chunks.
- Neo4j provides structured relationship information, which helps ground answers in explicit entity relationships.
- Combining both reduces hallucination risk for medical questions by giving Gemini both evidence and relational knowledge.

## Notes and limitations

- The current entity extraction from the user question is basic: it picks capitalized words and queries only two entities.
- `queryNeo4jRelationships()` only searches for paths between a start and end entity.
- This is a good starting point, but the graph query layer can be improved later by using better entity extraction and richer Cypher patterns.

## Environment requirements

Neo4j requires:
- `NEO4J_URI` — e.g. `neo4j+s://<your-database-id>.databases.neo4j.io`
- `NEO4J_USER`
- `NEO4J_PASSWORD`

This matches the AuraDB connection style shown in the example:

```python
URI = "neo4j+s://662eb5ef.databases.neo4j.io"
AUTH = ("<username>", "<password>")
```

## Summary

The project uses Cypher to store and query medical triples in Neo4j, then appends those results to the normal Pinecone-based retrieval prompt. This creates a hybrid GraphRAG pipeline where both similarity-based and relationship-based signals help Gemini produce a more accurate, medically grounded answer.