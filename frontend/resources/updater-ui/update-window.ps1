# Janela de progresso da atualização do Voice AI (Windows).
#
# Por que existe: ao atualizar, o app fecha e o instalador silencioso roda por ~1 min sem mostrar nada. O app não pode
# ficar aberto (o instalador precisa trocar os arquivos dele), então esta janela roda FORA da pasta de instalação
# (o app copia este script para uma pasta temporária antes de fechar) e acompanha o que acontece de verdade:
#
#   etapa                        sinal real usado
#   Fechando o Voice AI          processos do app dentro da pasta de instalação
#   Removendo a versão antiga    pasta de instalação encolhendo (bytes) / processo old-uninstaller
#   Instalando a nova versão     pasta de instalação crescendo (bytes) / processo do instalador
#   Abrindo o Voice AI           processo do app novo aparecendo
#
# A barra das etapas 2 e 3 é a fração real de bytes removida/escrita. O tamanho da versão nova é aproximado pelo da
# instalada (-OldBytes), por isso a barra não passa de 99% até o instalador terminar de fato. Nada aqui é estimado por tempo.
#
# Uso (o app chama assim):
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File update-window.ps1 -InstallDir <pasta> -FromVersion 1.3.4 `
#     -ToVersion 1.4.0 -OldBytes <bytes> -LogFile <arquivo> -ReadyFile <arquivo> -Logo <png>
# Demonstração (não mexe em nada):  ... -Demo        (ou -DemoError para ver a tela de erro)
param(
    [string]$InstallDir = '',
    [string]$FromVersion = '',
    [string]$ToVersion = '',
    [string]$AppExeName = 'Voice AI.exe',
    [long]$OldBytes = 0,
    [string]$LogFile = '',
    [string]$ReadyFile = '',
    [string]$Logo = '',
    [string]$InstallerPattern = 'Voice-AI-Setup*',
    [int]$TimeoutMin = 12,
    [switch]$Demo,
    [switch]$DemoError
)

$ErrorActionPreference = 'Stop'
if ($DemoError) { $Demo = [switch]$true }   # -DemoError é uma demonstração que termina em erro
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$script:t0 = Get-Date
function Write-Log([string]$msg, [string]$level = 'INFO') {
    if (-not $LogFile) { return }
    try {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        Add-Content -LiteralPath $LogFile -Value ("{0} {1,-5} [janela/atualização] {2}" -f $stamp, $level, $msg) -Encoding UTF8
    } catch { }
}

# ----- janela -----
$stepNames = @('Download concluído', 'Fechando o Voice AI', 'Removendo a versão antiga', 'Instalando a nova versão', 'Abrindo o Voice AI')

$rows = ''
for ($i = 0; $i -lt $stepNames.Count; $i++) {
    $rows += @"
        <Grid Margin="0,5,0,5">
          <Grid.ColumnDefinitions><ColumnDefinition Width="28"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <TextBlock x:Name="Icon$i" Grid.Column="0" FontFamily="Segoe UI Symbol" FontSize="15" Text="○" Foreground="#475569" VerticalAlignment="Center"/>
          <TextBlock x:Name="Label$i" Grid.Column="1" FontSize="14" Text="$($stepNames[$i])" Foreground="#64748B" VerticalAlignment="Center"/>
          <TextBlock x:Name="Pct$i" Grid.Column="2" FontSize="13" Text="" Foreground="#A5B4FC" VerticalAlignment="Center"/>
        </Grid>
"@
}

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Atualizando o Voice AI" Width="470" SizeToContent="Height" WindowStartupLocation="CenterScreen"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
        FontFamily="Segoe UI" SnapsToDevicePixels="True" UseLayoutRounding="True">
  <Window.Resources>
    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Foreground" Value="#E2E8F0"/>
      <Setter Property="Background" Value="#1E293B"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Margin" Value="6,0,0,0"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="{TemplateBinding Background}" BorderBrush="#334155" BorderThickness="1" CornerRadius="8" Padding="14,8">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="Background" Value="#334155"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="Root" Margin="14" CornerRadius="16" Background="#0F172A" BorderBrush="#334155" BorderThickness="1" Padding="30,28,30,24">
    <Border.Effect><DropShadowEffect BlurRadius="26" ShadowDepth="0" Opacity="0.55"/></Border.Effect>
    <StackPanel>
      <StackPanel Orientation="Horizontal">
        <Image x:Name="LogoImg" Width="52" Height="52" Margin="0,0,16,0"/>
        <StackPanel VerticalAlignment="Center">
          <TextBlock x:Name="Title" Text="Atualizando o Voice AI" FontSize="20" FontWeight="SemiBold" Foreground="#F1F5F9"/>
          <TextBlock x:Name="Subtitle" Text="" FontSize="13" Foreground="#94A3B8" Margin="0,3,0,0"/>
        </StackPanel>
      </StackPanel>

      <StackPanel Margin="0,22,0,0">
$rows
      </StackPanel>

      <Border x:Name="Track" Height="8" CornerRadius="4" Background="#1E293B" Margin="0,20,0,0" ClipToBounds="True">
        <Grid>
          <Border x:Name="Fill" Width="0" HorizontalAlignment="Left" CornerRadius="4" Background="#6366F1"/>
          <Border x:Name="Marquee" Width="130" HorizontalAlignment="Left" CornerRadius="4" Visibility="Collapsed">
            <Border.Background>
              <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                <GradientStop Color="#006366F1" Offset="0"/><GradientStop Color="#6366F1" Offset="0.5"/><GradientStop Color="#006366F1" Offset="1"/>
              </LinearGradientBrush>
            </Border.Background>
            <Border.RenderTransform><TranslateTransform x:Name="Slide" X="-130"/></Border.RenderTransform>
          </Border>
        </Grid>
      </Border>

      <TextBlock x:Name="Message" TextWrapping="Wrap" FontSize="12.5" Foreground="#94A3B8" Margin="0,16,0,0"
                 Text="Isso costuma levar cerca de 1 minuto. O Voice AI abre sozinho quando terminar."/>

      <StackPanel x:Name="Buttons" Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,18,0,0" Visibility="Collapsed">
        <Button x:Name="BtnOpen" Style="{StaticResource Btn}" Content="Abrir o app"/>
        <Button x:Name="BtnLogs" Style="{StaticResource Btn}" Content="Ver logs"/>
        <Button x:Name="BtnClose" Style="{StaticResource Btn}" Content="Fechar"/>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
"@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader ([xml]$xaml)))
$ui = @{}
foreach ($n in 'Root','LogoImg','Title','Subtitle','Track','Fill','Marquee','Slide','Message','Buttons','BtnOpen','BtnLogs','BtnClose') { $ui[$n] = $win.FindName($n) }
$icons  = 0..4 | ForEach-Object { $win.FindName("Icon$_") }
$labels = 0..4 | ForEach-Object { $win.FindName("Label$_") }
$pcts   = 0..4 | ForEach-Object { $win.FindName("Pct$_") }

if ($Logo -and (Test-Path -LiteralPath $Logo)) {
    try {
        $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
        $bmp.BeginInit(); $bmp.UriSource = New-Object System.Uri($Logo); $bmp.CacheOption = 'OnLoad'; $bmp.EndInit()
        $ui.LogoImg.Source = $bmp
    } catch { Write-Log "não consegui carregar o logo: $_" 'WARN' }
}
$ui.Subtitle.Text = if ($FromVersion -and $ToVersion) { "Versão $FromVersion  →  $ToVersion" } else { '' }
$win.Add_MouseLeftButtonDown({ try { $win.DragMove() } catch { } })

# ----- estado visual -----
$brush = { param($hex) (New-Object System.Windows.Media.BrushConverter).ConvertFromString($hex) }
$script:phase = 1          # 1 fechando, 2 removendo, 3 instalando, 4 abrindo, 5 concluído, -1 erro
$script:failedAt = 1       # etapa em que deu erro (para marcar com ✖)
$script:pct = @(0, 0, 0, 0, 0)
$script:marqueeOn = $false

function Set-Marquee([bool]$on) {
    if ($on -eq $script:marqueeOn) { return }
    $script:marqueeOn = $on
    $prop = [System.Windows.Media.TranslateTransform]::XProperty
    if ($on) {
        $ui.Fill.Visibility = 'Collapsed'; $ui.Marquee.Visibility = 'Visible'
        $w = [Math]::Max(200, $ui.Track.ActualWidth)
        $a = New-Object System.Windows.Media.Animation.DoubleAnimation(-130, $w, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(1300))))
        $a.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
        $ui.Slide.BeginAnimation($prop, $a)
    } else {
        $ui.Slide.BeginAnimation($prop, $null)
        $ui.Marquee.Visibility = 'Collapsed'; $ui.Fill.Visibility = 'Visible'
    }
}

function Render {
    $p = $script:phase
    for ($i = 0; $i -lt 5; $i++) {
        if ($p -eq 5 -or ($p -ge 1 -and $i -lt $p)) {
            $icons[$i].Text = '✔'; $icons[$i].Foreground = & $brush '#22C55E'
            $labels[$i].Foreground = & $brush '#CBD5E1'; $pcts[$i].Text = ''
        } elseif ($i -eq $p) {
            $icons[$i].Text = '●'; $icons[$i].Foreground = & $brush '#818CF8'
            $labels[$i].Foreground = & $brush '#F1F5F9'
            $pcts[$i].Text = if ($i -in 2, 3) { '{0}%' -f [int]($script:pct[$i] * 100) } else { '' }
        } elseif ($p -eq -1 -and $i -lt $script:failedAt) {
            $icons[$i].Text = '✔'; $icons[$i].Foreground = & $brush '#22C55E'
            $labels[$i].Foreground = & $brush '#CBD5E1'; $pcts[$i].Text = ''
        } elseif ($p -eq -1 -and $i -eq $script:failedAt) {
            $icons[$i].Text = '✖'; $icons[$i].Foreground = & $brush '#EF4444'
            $labels[$i].Foreground = & $brush '#FCA5A5'; $pcts[$i].Text = ''
        } else {
            $icons[$i].Text = '○'; $icons[$i].Foreground = & $brush '#475569'
            $labels[$i].Foreground = & $brush '#64748B'; $pcts[$i].Text = ''
        }
    }
    # barra: indeterminada nas etapas sem medida (fechar, abrir); real nas outras
    if ($p -eq 5) { Set-Marquee $false; $ui.Fill.Width = $ui.Track.ActualWidth; $ui.Fill.Background = & $brush '#22C55E' }
    elseif ($p -eq -1) { Set-Marquee $false; $ui.Fill.Background = & $brush '#EF4444' }
    elseif ($p -in 2, 3) { Set-Marquee $false; $ui.Fill.Width = $ui.Track.ActualWidth * [Math]::Min(1.0, $script:pct[$p]) }
    else { Set-Marquee $true }
}

function Show-Error([string]$title, [string]$msg) {
    Write-Log "$title - $msg" 'ERROR'
    if ($script:phase -ge 1) { $script:failedAt = $script:phase }
    $script:phase = -1
    $ui.Title.Text = $title
    $ui.Message.Text = $msg
    $ui.Message.Foreground = & $brush '#FCA5A5'
    $ui.Buttons.Visibility = 'Visible'
    $ui.Fill.Width = $ui.Track.ActualWidth
    Render
}

$ui.BtnClose.Add_Click({ $win.Close() })
$ui.BtnOpen.Add_Click({
    $exe = Join-Path $InstallDir $AppExeName
    if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe; $win.Close() }
    else { $ui.Message.Text = 'O Voice AI não foi encontrado na pasta de instalação. Rode o instalador de novo.' }
})
$ui.BtnLogs.Add_Click({ if ($LogFile) { Start-Process explorer.exe (Split-Path -Parent $LogFile) } })

# ----- medidas reais -----
function Get-DirBytes([string]$d) {
    try {
        $di = New-Object System.IO.DirectoryInfo($d)
        if (-not $di.Exists) { return 0L }
        $t = 0L
        foreach ($f in $di.EnumerateFiles('*', [System.IO.SearchOption]::AllDirectories)) { $t += $f.Length }
        return $t
    } catch { return -1L }   # arquivo sumiu no meio da contagem: mantém a última medida
}
function Test-AppRunning {
    if (-not $InstallDir) { return $false }
    foreach ($p in (Get-Process -Name ($AppExeName -replace '\.exe$', '') -ErrorAction SilentlyContinue)) {
        try { if ($p.Path -and $p.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) { return $true } } catch { }
    }
    return $false
}
function Test-Proc([string]$name) { return [bool](Get-Process -Name $name -ErrorAction SilentlyContinue) }

$script:phaseStart = @{ 1 = (Get-Date) }
$script:lastBytes = $OldBytes
$script:minBytes = $OldBytes
$script:sawInstaller = $false
$script:sawUninstaller = $false
$script:installerGoneAt = $null
$script:doneAt = $null

function Enter-Phase([int]$n) {
    if ($n -le $script:phase) { return }
    $took = [int]((Get-Date) - $script:phaseStart[$script:phase]).TotalSeconds
    Write-Log ("etapa {0} ({1}) levou {2} s" -f $script:phase, $stepNames[$script:phase], $took)
    $script:phase = $n
    $script:phaseStart[$n] = Get-Date
    if ($n -le 4) { Write-Log ("etapa {0}: {1}" -f $n, $stepNames[$n]) }
}

# ----- ciclo principal (real) -----
function Tick-Real {
    $elapsed = ((Get-Date) - $script:t0).TotalMinutes
    if ($elapsed -gt $TimeoutMin) {
        Show-Error 'A atualização está demorando demais' "Já se passaram $TimeoutMin minutos. Abra o Voice AI pelo menu Iniciar; se ele abrir na versão antiga, rode a atualização de novo."
        return
    }
    $appUp = Test-AppRunning
    $instUp = Test-Proc $InstallerPattern
    $unUp = Test-Proc 'old-uninstaller'
    if ($instUp) { $script:sawInstaller = $true }
    if ($unUp) { $script:sawUninstaller = $true }

    switch ($script:phase) {
        1 { if (-not $appUp) { Enter-Phase 2 } }
        { $_ -in 2, 3 } {
            $b = Get-DirBytes $InstallDir
            if ($b -ge 0) {
                $script:lastBytes = $b
                if ($b -lt $script:minBytes) { $script:minBytes = $b }
            }
            $old = [double][Math]::Max(1, $OldBytes)
            if ($script:phase -eq 2) {
                $script:pct[2] = [Math]::Min(1.0, [Math]::Max(0.0, 1.0 - ($script:lastBytes / $old)))
                $removed = ($script:sawUninstaller -and -not $unUp) -or ($script:lastBytes -lt 0.03 * $old)
                $grew = $script:lastBytes -gt ($script:minBytes + 0.03 * $old)
                if ($removed -or $grew) { $script:pct[2] = 1.0; Enter-Phase 3 }
            }
            if ($script:phase -eq 3) {
                $script:pct[3] = [Math]::Min(0.99, [Math]::Max(0.0, $script:lastBytes / $old))
                if ($script:sawInstaller -and -not $instUp) { $script:pct[3] = 1.0; Enter-Phase 4 }
            }
        }
        4 {
            if ($appUp) {
                Enter-Phase 5
                $total = [int]((Get-Date) - $script:t0).TotalSeconds
                Write-Log "atualização concluída em $total s: o app novo abriu"
                $ui.Title.Text = 'Atualização concluída'
                $ui.Message.Text = 'Tudo certo! O Voice AI já está aberto.'
                $script:doneAt = Get-Date
            } else {
                if (-not $script:installerGoneAt) { $script:installerGoneAt = Get-Date }
                if (((Get-Date) - $script:installerGoneAt).TotalSeconds -gt 40) {
                    $exe = Join-Path $InstallDir $AppExeName
                    if (Test-Path -LiteralPath $exe) {
                        Show-Error 'O Voice AI não abriu sozinho' 'A instalação terminou, mas o app não abriu. Clique em "Abrir o Voice AI". Se não funcionar, abra pelo menu Iniciar.'
                    } else {
                        Show-Error 'A instalação não foi concluída' 'O instalador terminou sem deixar o app na pasta de instalação. Baixe o instalador na página de releases e rode-o de novo.'
                    }
                }
            }
        }
        5 { if ($script:doneAt -and ((Get-Date) - $script:doneAt).TotalSeconds -gt 1.6) { $win.Close() } }
    }
    # instalador nunca apareceu e o app não voltou: algo deu errado antes de instalar
    if ($script:phase -in 2, 3 -and -not $script:sawInstaller -and $elapsed -gt 0.6) {
        Show-Error 'O instalador não iniciou' 'Não consegui acompanhar a instalação. Abra o Voice AI pelo menu Iniciar; se ele abrir na versão antiga, rode a atualização de novo.'
        return
    }
    Render
}

# ----- demonstração (sem tocar em nada) -----
$script:demoT = Get-Date
function Tick-Demo {
    $s = ((Get-Date) - $script:demoT).TotalSeconds
    if ($s -lt 2.5) { $script:phase = 1 }
    elseif ($s -lt 8) { $script:phase = 2; $script:pct[2] = ($s - 2.5) / 5.5 }
    elseif ($s -lt 17) {
        $script:phase = 3; $script:pct[2] = 1; $script:pct[3] = [Math]::Min(0.99, ($s - 8) / 9)
        if ($DemoError -and $s -gt 12) { Show-Error 'A instalação não foi concluída' 'Demonstração da tela de erro: o instalador terminou sem deixar o app na pasta de instalação.'; return }
    }
    elseif ($s -lt 20) { $script:phase = 4; $script:pct[3] = 1 }
    else {
        $script:phase = 5; $ui.Title.Text = 'Atualização concluída'; $ui.Message.Text = 'Tudo certo! O Voice AI já está aberto.'
        if ($s -gt 22) { $win.Close() }
    }
    Render
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(800)
$timer.Add_Tick({
    try { if ($script:phase -ne -1) { if ($Demo) { Tick-Demo } else { Tick-Real } } }
    catch { Write-Log "erro no acompanhamento: $_" 'ERROR' }
})

$win.Add_ContentRendered({
    Write-Log ("janela aberta: {0} -> {1}, pasta {2}, tamanho anterior {3:N0} MB" -f $FromVersion, $ToVersion, $InstallDir, ($OldBytes / 1MB))
    Write-Log "etapa 1: $($stepNames[1])"
    if ($ReadyFile) { try { New-Item -ItemType File -Force -Path $ReadyFile | Out-Null } catch { } }
    Render
    $timer.Start()
})
$win.Add_Closed({ $timer.Stop(); Write-Log 'janela fechada' })

[void]$win.ShowDialog()
