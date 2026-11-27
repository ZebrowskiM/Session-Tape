# Run from PowerShell with GitHub CLI signed in as ZebrowskiM:
# gh auth refresh -h github.com -s project
# .\scripts\Sync-Roadmap.ps1
# .\scripts\Sync-Roadmap.ps1 -Mode Preview   # Show field changes on project 5.
# .\scripts\Sync-Roadmap.ps1 -Mode Triage    # Apply the changes on project 5.
# Use -ProjectNumber to select another existing project owned by ZebrowskiM.
[CmdletBinding()]
param(
    [ValidateRange(1, 2147483647)][int]$ProjectNumber,
    [ValidateSet('Sync', 'Triage', 'Preview')][string]$Mode = 'Sync'
)

$ErrorActionPreference = 'Stop'
$owner = 'ZebrowskiM'
$repo = "$owner/Session-Tape"
$title = 'Session Tape Roadmap'
$viewName = 'By milestone'
$apiVersion = 'X-GitHub-Api-Version: 2026-03-10'

function Invoke-Gh([string[]]$Arguments) {
    $output = & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI failed during 'gh $($Arguments[0])'. Check the error above before retrying."
    }
    $output
}

$account = Invoke-Gh @('api', 'user') | ConvertFrom-Json
if ($account.login -ne $owner) { throw "Select the $owner GitHub CLI account first." }
if ($Mode -eq 'Sync') {
    $issues = @(Invoke-Gh @('api', '--paginate', "repos/$repo/issues?labels=roadmap&state=all&per_page=100",
        '--jq', '.[] | select(.pull_request == null) | .html_url'))
    if ($issues.Count -eq 0) { throw "No roadmap issues found in $repo." }
}
if ($Mode -ne 'Sync' -and !$ProjectNumber) { $ProjectNumber = 5 }
if (!$ProjectNumber) {
    $projects = Invoke-Gh @('project', 'list', '--owner', $owner, '--limit', '1000', '--format', 'json') | ConvertFrom-Json
    $existing = @($projects.projects | Where-Object { $_.title -in @($title, 'Session Tape') })
    if ($existing.Count) {
        throw "An existing Session Tape board was found. Select its number with -ProjectNumber."
    }
    $repositoryId = Invoke-Gh @('api', "repos/$repo", '--jq', '.node_id')
    $create = 'mutation($owner:ID!, $repo:ID!, $title:String!) { createProjectV2(input:{ownerId:$owner,repositoryId:$repo,title:$title}) { projectV2 { number } } }'
    $ProjectNumber = [int](Invoke-Gh @('api', 'graphql', '-f', "query=$create", '-f', "owner=$($account.node_id)",
        '-f', "repo=$repositoryId", '-f', "title=$title", '--jq', '.data.createProjectV2.projectV2.number'))
    Write-Host "Created project $ProjectNumber. To resume, rerun with -ProjectNumber $ProjectNumber."
}

$query = 'query($owner:String!, $number:Int!) { user(login:$owner) { projectV2(number:$number) { id title url closed repositories(first:100){nodes{nameWithOwner}} views(first:100){nodes{number name layout}} } } }'
$project = Invoke-Gh @('api','graphql','-f',"query=$query",'-f',"owner=$owner",'-F',"number=$ProjectNumber",
    '--jq','.data.user.projectV2') | ConvertFrom-Json
if (!$project.id -or $project.closed) { throw "No open project $ProjectNumber found under $owner." }

if ($Mode -ne 'Sync') {
    $fieldQuery = 'query($owner:String!, $number:Int!) { user(login:$owner) { projectV2(number:$number) { fields(first:100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }'
    $scope = @('-f', "owner=$owner", '-F', "number=$ProjectNumber")
    $fieldRows = Invoke-Gh (@('api','graphql','-f',"query=$fieldQuery") + $scope +
        @('--jq','.data.user.projectV2.fields.nodes[] | @json'))
    $fields = @{}
    foreach ($row in $fieldRows) {
        $field = $row | ConvertFrom-Json
        if ($field.name -in @('Priority','Status')) { $fields[$field.name] = $field }
    }

    $itemQuery = @'
query($owner:String!, $number:Int!, $endCursor:String, $status:String!, $priority:String!) {
  user(login:$owner) { projectV2(number:$number) { items(first:100, after:$endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id isArchived
      content {
        ... on Issue { number state repository { nameWithOwner } labels(first:100) { nodes { name } } }
        ... on PullRequest { number state repository { nameWithOwner } labels(first:100) { nodes { name } } }
      }
      Status: fieldValueByName(name:$status) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      Priority: fieldValueByName(name:$priority) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    }
  } } }
}
'@
    function Get-TriageCards {
        $rows = Invoke-Gh (@('api','graphql','--paginate','-f',"query=$itemQuery") + $scope +
            @('-f','status=Status','-f','priority=Priority','--jq','.data.user.projectV2.items.nodes[] | @json'))
        foreach ($row in $rows) { $row | ConvertFrom-Json }
    }

    $changes = @(foreach ($card in Get-TriageCards) {
        $content = $card.content
        if ($card.isArchived -or $content.repository.nameWithOwner -ne $repo -or $content.state -ne 'OPEN') { continue }
        $labels = @($content.labels.nodes.name)
        $choices = @{}
        if (!$card.Priority.name) {
            $levels = @('p0','p1','p2' | Where-Object { "priority:$_" -in $labels })
            if ($levels.Count -gt 1) { throw "Conflicting priority labels on #$($content.number)." }
            if ($levels.Count -eq 1) { $choices['Priority'] = $levels[0].ToUpperInvariant() }
        }
        if (!$card.Status.name -or $card.Status.name -eq 'Backlog') {
            $ready = 'flow:ready' -in $labels
            $active = 'flow:in-progress' -in $labels
            if ($ready -and $active) { throw "Conflicting flow labels on #$($content.number)." }
            if ($ready) { $choices['Status'] = 'Ready' }
            if ($active) { $choices['Status'] = 'In progress' }
        }
        foreach ($name in $choices.Keys) {
            $field = $fields[$name]
            $value = $choices[$name]
            $option = $field.options | Where-Object { $_.name -eq $value }
            if (!$option.id) { throw "Project $ProjectNumber needs a '$value' option in '$name'." }
            [pscustomobject]@{ Item = $card.id; Number = $content.number; Field = $name
                Value = $value; FieldId = $field.id; OptionId = $option.id }
        }
    })
    foreach ($change in $changes) {
        Write-Host "#$($change.Number)  $($change.Field) -> $($change.Value)"
        if ($Mode -eq 'Triage') {
            Invoke-Gh @('project','item-edit','--project-id',$project.id,'--id',$change.Item,
                '--field-id',$change.FieldId,'--single-select-option-id',$change.OptionId) | Out-Null
        }
    }
    if ($Mode -eq 'Preview') {
        Write-Host "$($changes.Count) proposed field updates on $($project.url)."
        return
    }
    if ($changes.Count) {
        $byId = @{}
        foreach ($card in Get-TriageCards) { $byId[$card.id] = $card }
        foreach ($change in $changes) {
            $current = $byId[$change.Item]
            if ($current.($change.Field).name -ne $change.Value) {
                throw "Could not verify $($change.Field) on #$($change.Number). Recheck the board before retrying."
            }
        }
    }
    Write-Host "Verified $($changes.Count) field updates on $($project.url)."
    return
}

if ($repo -notin $project.repositories.nodes.nameWithOwner) {
    Invoke-Gh @('project','link',"$ProjectNumber",'--owner',$owner,'--repo','Session-Tape') | Out-Null
}

$itemsQuery = 'query($owner:String!, $number:Int!, $endCursor:String) { user(login:$owner) { projectV2(number:$number) { items(first:100,after:$endCursor) { nodes { content { ... on Issue { url } } } pageInfo { hasNextPage endCursor } } } } }'
function Get-IssueUrls {
    Invoke-Gh @('api','graphql','--paginate','-f',"query=$itemsQuery",'-f',"owner=$owner",'-F',"number=$ProjectNumber",
        '--jq','.data.user.projectV2.items.nodes[].content.url // empty')
}
$members = @(Get-IssueUrls)
foreach ($issue in $issues) {
    if ($issue -notin $members) {
        Invoke-Gh @('project','item-add',"$ProjectNumber",'--owner',$owner,'--url',$issue) | Out-Null
    }
}
$members = @(Get-IssueUrls)
$missing = @($issues | Where-Object { $_ -notin $members })
if ($missing.Count) { throw "Board membership could not be verified for $($missing.Count) issues. Rerun with -ProjectNumber $ProjectNumber." }

$view = $project.views.nodes | Where-Object { $_.name -eq $viewName } | Select-Object -First 1
if ($view -and $view.layout -ne 'BOARD_LAYOUT') { throw "A non-board view already uses the name '$viewName'." }
if (!$view) {
    $fieldsUrl = "users/$owner/projectsV2/$ProjectNumber/fields?per_page=100"
    $fields = Invoke-Gh @('api', $fieldsUrl, '-H', $apiVersion) | ConvertFrom-Json
    $milestone = $fields | Where-Object { $_.name -eq 'Milestone' } | Select-Object -First 1
    if (!$milestone.id) { throw 'The project did not return its Milestone field.' }
    $viewsUrl = "users/$($account.id)/projectsV2/$ProjectNumber/views"
    $view = Invoke-Gh @('api', $viewsUrl, '--method', 'POST', '-H', $apiVersion, '-f', "name=$viewName",
        '-f', 'layout=board', '-F', "vertical_group_by[]=$($milestone.id)") | ConvertFrom-Json
}
Write-Host "Verified $($issues.Count) roadmap issues. Open $($project.url)/views/$($view.number)"
